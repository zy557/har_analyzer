import json
import os
from datetime import datetime
from typing import Any, Dict, List, Optional


def _parse_iso_datetime(value: str) -> Optional[datetime]:
    """Parse ISO8601 with optional milliseconds and trailing 'Z'."""
    if not value:
        return None
    value = value.strip()
    # Normalize trailing Z to +00:00 for fromisoformat
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(value)
    except Exception:
        # Best-effort fallbacks
        for fmt in (
            "%Y-%m-%dT%H:%M:%S.%f%z",
            "%Y-%m-%dT%H:%M:%S%z",
            "%Y-%m-%d %H:%M:%S%z",
        ):
            try:
                return datetime.strptime(value, fmt)
            except Exception:
                continue
    return None


def parse_har_file(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize_entries(har: Dict[str, Any]) -> List[Dict[str, Any]]:
    log = har.get("log", {})
    entries: List[Dict[str, Any]] = log.get("entries", [])
    if not entries:
        return []

    parsed_times: List[Optional[datetime]] = [
        _parse_iso_datetime(e.get("startedDateTime")) for e in entries
    ]
    first_time: Optional[datetime] = None
    for t in parsed_times:
        if t is not None:
            first_time = t
            break

    normalized: List[Dict[str, Any]] = []
    rolling_ms = 0.0
    for i, e in enumerate(entries):
        t = parsed_times[i]
        if first_time and t:
            started_ms = (t - first_time).total_seconds() * 1000.0
        else:
            started_ms = rolling_ms
        total_time = float(e.get("time", 0) or 0)
        rolling_ms += total_time

        req = e.get("request", {})
        resp = e.get("response", {})
        mime = (resp.get("content", {}) or {}).get("mimeType", "")
        url = req.get("url", "")
        method = req.get("method", "")
        status = resp.get("status", 0)
        status_text = resp.get("statusText", "")

        # Size: prefer response.content.size or bodySize
        content = resp.get("content", {}) or {}
        size = content.get("size")
        if size is None:
            size = resp.get("bodySize")
        if size is None:
            size = 0

        # Timing segments for a rough waterfall
        timings = e.get("timings", {}) or {}
        segs = {
            "blocked": _to_num(timings.get("blocked")),
            "dns": _to_num(timings.get("dns")),
            "connect": _to_num(timings.get("connect")),
            "ssl": _to_num(timings.get("ssl")),
            "send": _to_num(timings.get("send")),
            "wait": _to_num(timings.get("wait")),
            "receive": _to_num(timings.get("receive")),
        }

        # Extra fields (best-effort for DevTools parity)
        resource_type = raw_get(e, ["_resourceType", "_type"]) or infer_resource_type(mime)
        priority = raw_get(e, ["_priority"]) or raw_get(req, ["_priority"]) or None
        initiator = raw_get(e, ["_initiator"]) or None

        normalized.append(
            {
                "_raw": e,
                "id": i,
                "url": url,
                "method": method,
                "status": status,
                "statusText": status_text,
                "mimeType": mime,
                "time": total_time,
                "size": size,
                "started_ms": started_ms,
                "timingSegments": segs,
                "resourceType": resource_type,
                "priority": priority,
                "initiator": initiator,
            }
        )

    return normalized


def _to_num(v: Any) -> float:
    try:
        return float(v) if v is not None and v != -1 else 0.0
    except Exception:
        return 0.0


def build_entry_summary(entry: Dict[str, Any]) -> Dict[str, Any]:
    # Derive host and path
    host = ""
    path = ""
    url = entry.get("url", "")
    try:
        from urllib.parse import urlparse

        p = urlparse(url)
        host = p.netloc
        path = p.path
    except Exception:
        pass

    return {
        "id": entry.get("id"),
        "url": url,
        "host": host,
        "path": path,
        "method": entry.get("method"),
        "status": entry.get("status"),
        "statusText": entry.get("statusText"),
        "mimeType": entry.get("mimeType"),
        "time": entry.get("time"),
        "size": entry.get("size"),
        "started_ms": entry.get("started_ms"),
        "timingSegments": entry.get("timingSegments"),
    }


def build_entry_detail(entry: Dict[str, Any]) -> Dict[str, Any]:
    raw = entry.get("_raw", {})
    req = raw.get("request", {}) or {}
    resp = raw.get("response", {}) or {}
    timings = raw.get("timings", {}) or {}

    # Response body
    content = resp.get("content", {}) or {}
    text = content.get("text")
    encoding = content.get("encoding")
    decoded_text = None
    if isinstance(text, str):
        if encoding == "base64":
            try:
                import base64

                decoded_text = base64.b64decode(text).decode("utf-8", errors="replace")
            except Exception:
                decoded_text = text
        else:
            decoded_text = text

    return {
        "summary": build_entry_summary(entry),
        "request": {
            "url": req.get("url"),
            "method": req.get("method"),
            "httpVersion": req.get("httpVersion"),
            "headers": req.get("headers", []),
            "cookies": req.get("cookies", []),
            "queryString": req.get("queryString", []),
            "headersSize": req.get("headersSize"),
            "bodySize": req.get("bodySize"),
            "postData": req.get("postData"),
        },
        "response": {
            "status": resp.get("status"),
            "statusText": resp.get("statusText"),
            "httpVersion": resp.get("httpVersion"),
            "headers": resp.get("headers", []),
            "cookies": resp.get("cookies", []),
            "redirectURL": resp.get("redirectURL"),
            "headersSize": resp.get("headersSize"),
            "bodySize": resp.get("bodySize"),
            "content": {
                "size": content.get("size"),
                "mimeType": content.get("mimeType"),
                "text": decoded_text,
            },
        },
        "timings": timings,
        "serverIPAddress": raw.get("serverIPAddress"),
        "connection": raw.get("connection"),
        "startedDateTime": raw.get("startedDateTime"),
        "time": raw.get("time"),
        "resourceType": entry.get("resourceType"),
        "priority": entry.get("priority"),
        "initiator": entry.get("initiator"),
    }


def build_stats(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    total_size = sum(int(e.get("size", 0) or 0) for e in entries)
    total_time = sum(float(e.get("time", 0) or 0.0) for e in entries)
    by_status: Dict[str, int] = {}
    by_mime: Dict[str, int] = {}
    by_domain: Dict[str, int] = {}
    by_type: Dict[str, int] = {}
    for e in entries:
        s = str(e.get("status"))
        by_status[s] = by_status.get(s, 0) + 1
        m = e.get("mimeType") or "unknown"
        by_mime[m] = by_mime.get(m, 0) + 1
        # domain
        try:
            from urllib.parse import urlparse

            host = urlparse(e.get("url", "")).netloc
            if host:
                by_domain[host] = by_domain.get(host, 0) + 1
        except Exception:
            pass
        t = e.get("resourceType") or "unknown"
        by_type[t] = by_type.get(t, 0) + 1
    return {
        "count": len(entries),
        "totalSize": total_size,
        "totalTime": total_time,
        "byStatus": by_status,
        "byMimeType": by_mime,
        "byDomain": by_domain,
        "byResourceType": by_type,
    }


def raw_get(obj: Dict[str, Any], keys: List[str]) -> Any:
    for k in keys:
        v = obj.get(k)
        if v is not None:
            return v
    return None


def infer_resource_type(mime: str) -> str:
    if not mime:
        return "other"
    m = mime.lower()
    if m.startswith("image/"):
        return "image"
    if "javascript" in m or m.endswith("/js"):
        return "script"
    if "css" in m:
        return "stylesheet"
    if "html" in m:
        return "document"
    if "json" in m:
        return "xhr"
    return "other"