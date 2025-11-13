import os
from typing import Optional

from fastapi import FastAPI, Request, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.templating import Jinja2Templates

from server.har_utils import (
    parse_har_file,
    normalize_entries,
    build_entry_summary,
    build_entry_detail,
    build_stats,
)
from server.event_relations import build_event_graph, build_phase_stats


app = FastAPI(title="HAR Viewer")

# Folders
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.abspath(os.path.join(BASE_DIR, os.pardir))
UPLOAD_DIR = os.path.join(ROOT_DIR, "uploads")
STATIC_DIR = os.path.join(ROOT_DIR, "static")
TEMPLATE_DIR = os.path.join(ROOT_DIR, "templates")

os.makedirs(UPLOAD_DIR, exist_ok=True)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATE_DIR)


STATE = {
    "har_path": None,  # type: Optional[str]
    "entries": [],
}


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/events")
async def events_page(request: Request):
    return templates.TemplateResponse("events.html", {"request": request})


@app.post("/api/upload")
async def upload_har(file: UploadFile = File(...)):
    if not file.filename.endswith(".har"):
        raise HTTPException(status_code=400, detail="请上传 .har 文件")
    target = os.path.join(UPLOAD_DIR, file.filename)
    content = await file.read()
    with open(target, "wb") as f:
        f.write(content)
    try:
        har = parse_har_file(target)
        entries = normalize_entries(har)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"HAR 解析失败: {e}")

    STATE["har_path"] = target
    STATE["entries"] = entries
    return {"message": "上传并解析成功", "entries": [build_entry_summary(e) for e in entries]}


@app.get("/api/load-sample")
async def load_sample():
    # Try local sample files
    candidates = [
        os.path.join(ROOT_DIR, "www.baidu.com.har"),
        os.path.join(ROOT_DIR, "har-analyzer-main", "sample.har"),
    ]
    target = None
    for p in candidates:
        if os.path.exists(p):
            target = p
            break
    if not target:
        raise HTTPException(status_code=404, detail="未找到示例 HAR 文件")

    try:
        har = parse_har_file(target)
        entries = normalize_entries(har)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"HAR 解析失败: {e}")

    STATE["har_path"] = target
    STATE["entries"] = entries
    return {"message": "已加载示例 HAR", "entries": [build_entry_summary(e) for e in entries]}


def _filter_entries(entries, q: Optional[str], domain: Optional[str], status: Optional[str], mime: Optional[str], method: Optional[str], rtype: Optional[str], priority: Optional[str], status_min: Optional[int], status_max: Optional[int]):
    def match(e):
        ok = True
        if q:
            ql = q.lower()
            ok = ok and (
                (e.get("url", "").lower().find(ql) != -1)
                or (str(e.get("status", "")).find(ql) != -1)
                or ((e.get("mimeType") or "").lower().find(ql) != -1)
            )
        if domain:
            try:
                from urllib.parse import urlparse

                ok = ok and (urlparse(e.get("url", "")).netloc == domain)
            except Exception:
                ok = False
        if status:
            ok = ok and (str(e.get("status")) == str(status))
        if status_min is not None:
            try:
                ok = ok and (int(e.get("status", 0)) >= int(status_min))
            except Exception:
                pass
        if status_max is not None:
            try:
                ok = ok and (int(e.get("status", 0)) <= int(status_max))
            except Exception:
                pass
        if mime:
            ok = ok and ((e.get("mimeType") or "") == mime)
        if method:
            ok = ok and ((e.get("method") or "") == method)
        if rtype:
            ok = ok and ((e.get("resourceType") or "") == rtype)
        if priority:
            ok = ok and (str(e.get("priority") or "") == str(priority))
        return ok

    return list(filter(match, entries))


@app.get("/api/entries")
async def list_entries(request: Request):
    # Pagination and filters
    try:
        offset = int(request.query_params.get("offset", 0))
        limit = int(request.query_params.get("limit", 200))
        q = request.query_params.get("q")
        domain = request.query_params.get("domain")
        status = request.query_params.get("status")
        mime = request.query_params.get("mime")
        method = request.query_params.get("method")
        rtype = request.query_params.get("type")
        priority = request.query_params.get("priority")
        status_min = request.query_params.get("statusMin")
        status_max = request.query_params.get("statusMax")
        status_min = int(status_min) if status_min is not None else None
        status_max = int(status_max) if status_max is not None else None
    except Exception:
        raise HTTPException(status_code=400, detail="分页参数错误")

    entries = STATE["entries"]
    filtered = _filter_entries(entries, q, domain, status, mime, method, rtype, priority, status_min, status_max)
    total = len(filtered)
    # Sort by start time for stable order
    filtered.sort(key=lambda e: e.get("started_ms", 0))
    page = filtered[offset : offset + limit]
    return {"total": total, "entries": [build_entry_summary(e) for e in page]}


@app.get("/api/entries/{entry_id}")
async def get_entry(entry_id: int):
    entries = STATE["entries"]
    if entry_id < 0 or entry_id >= len(entries):
        raise HTTPException(status_code=404, detail="未找到条目")
    return build_entry_detail(entries[entry_id])


@app.get("/api/entries/{entry_id}/body")
async def get_entry_body(entry_id: int):
    entries = STATE["entries"]
    if entry_id < 0 or entry_id >= len(entries):
        raise HTTPException(status_code=404, detail="未找到条目")
    raw = entries[entry_id].get("_raw", {})
    resp = raw.get("response", {}) or {}
    content = resp.get("content", {}) or {}
    mime = content.get("mimeType") or "application/octet-stream"
    text = content.get("text")
    encoding = content.get("encoding")
    size = int(content.get("size") or resp.get("bodySize") or 0)

    max_preview = 200_000  # chars
    result = {"mimeType": mime, "encoding": encoding, "size": size, "truncated": False}
    if text is None:
        return result

    if encoding == "base64":
        # Return data URL for image preview; otherwise return truncated base64 or decoded text as preview
        try:
            import base64

            raw_bytes = base64.b64decode(text)
            if mime.startswith("image/"):
                # Provide data URL directly (client will set <img src>)
                b64 = text if len(text) <= max_preview else text[:max_preview]
                result.update({"dataUrl": f"data:{mime};base64,{b64}", "truncated": len(text) > max_preview, "isBinary": True})
            else:
                # Try decode as UTF-8 for preview
                preview = raw_bytes.decode("utf-8", errors="replace")
                if len(preview) > max_preview:
                    preview = preview[:max_preview]
                    result["truncated"] = True
                result.update({"previewText": preview, "isBinary": False})
        except Exception:
            # Fallback to base64 preview
            b64 = text if len(text) <= max_preview else text[:max_preview]
            result.update({"previewText": b64, "isBinary": True, "truncated": len(text) > max_preview})
    else:
        # Plain text string
        preview = text
        if len(preview) > max_preview:
            preview = preview[:max_preview]
            result["truncated"] = True
        result.update({"previewText": preview, "isBinary": False})
    return result


@app.get("/api/entries/{entry_id}/download")
async def download_entry_body(entry_id: int):
    entries = STATE["entries"]
    if entry_id < 0 or entry_id >= len(entries):
        raise HTTPException(status_code=404, detail="未找到条目")
    raw = entries[entry_id].get("_raw", {})
    resp = raw.get("response", {}) or {}
    content = resp.get("content", {}) or {}
    mime = content.get("mimeType") or "application/octet-stream"
    text = content.get("text")
    encoding = content.get("encoding")
    filename = f"entry-{entry_id}"

    data = b""
    if text is None:
        data = b""
    elif encoding == "base64":
        import base64

        try:
            data = base64.b64decode(text)
        except Exception:
            data = text.encode("utf-8", errors="replace")
    else:
        data = str(text).encode("utf-8", errors="replace")

    headers = {"Content-Type": mime, "Content-Disposition": f"attachment; filename={filename}"}
    return Response(content=data, media_type=mime, headers=headers)


@app.get("/api/stats")
async def get_stats():
    return build_stats(STATE["entries"])


@app.get("/api/event-graph")
async def get_event_graph():
    """返回推断的事件关系图（节点与边）。"""
    return build_event_graph(STATE["entries"])


@app.get("/api/event-stats")
async def get_event_stats():
    """返回各阶段耗时的总计与按资源类型的分布统计。"""
    return build_phase_stats(STATE["entries"])