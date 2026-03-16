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


def build_network_analysis(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Return automated network analysis insights:
    - slowRequests: top-10 slowest entries
    - largeResponses: top-10 largest entries
    - errorRequests: 4xx/5xx entries
    - redirectChains: sequences of 3xx responses
    - domainStats: per-domain request count, total size, total time
    - summary: high-level counts and metrics
    """
    from urllib.parse import urlparse

    # ── Slow requests ──────────────────────────────────────────────────────
    sorted_by_time = sorted(entries, key=lambda e: float(e.get("time") or 0), reverse=True)
    slow_requests = [
        {
            "id": e.get("id"),
            "url": e.get("url"),
            "method": e.get("method"),
            "status": e.get("status"),
            "time": float(e.get("time") or 0),
            "size": int(e.get("size") or 0),
            "resourceType": e.get("resourceType"),
        }
        for e in sorted_by_time[:10]
    ]

    # ── Large responses ────────────────────────────────────────────────────
    sorted_by_size = sorted(entries, key=lambda e: int(e.get("size") or 0), reverse=True)
    large_responses = [
        {
            "id": e.get("id"),
            "url": e.get("url"),
            "method": e.get("method"),
            "status": e.get("status"),
            "time": float(e.get("time") or 0),
            "size": int(e.get("size") or 0),
            "resourceType": e.get("resourceType"),
            "mimeType": e.get("mimeType"),
        }
        for e in sorted_by_size[:10]
    ]

    # ── Error requests ─────────────────────────────────────────────────────
    error_requests = [
        {
            "id": e.get("id"),
            "url": e.get("url"),
            "method": e.get("method"),
            "status": e.get("status"),
            "statusText": e.get("statusText"),
            "time": float(e.get("time") or 0),
            "resourceType": e.get("resourceType"),
        }
        for e in entries
        if isinstance(e.get("status"), int) and e["status"] >= 400
    ]

    # ── Redirect chains ────────────────────────────────────────────────────
    url_to_entry: Dict[str, Dict[str, Any]] = {}
    for e in entries:
        url = e.get("url") or ""
        if url:
            url_to_entry[url] = e

    redirect_chains: List[List[Dict[str, Any]]] = []
    visited_redirects: set = set()
    for e in entries:
        status = e.get("status") or 0
        if not (isinstance(status, int) and 300 <= status < 400):
            continue
        eid = e.get("id")
        if eid in visited_redirects:
            continue
        # Start a chain
        chain = [{"id": e.get("id"), "url": e.get("url"), "status": status}]
        visited_redirects.add(eid)
        raw = e.get("_raw", {}) or {}
        resp = raw.get("response", {}) or {}
        redirect_url = resp.get("redirectURL") or ""
        if not redirect_url:
            for h in (resp.get("headers") or []):
                if isinstance(h, dict) and (h.get("name") or "").lower() == "location":
                    redirect_url = h.get("value") or ""
                    break
        while redirect_url and redirect_url in url_to_entry:
            next_e = url_to_entry[redirect_url]
            next_id = next_e.get("id")
            if next_id in visited_redirects:
                break
            visited_redirects.add(next_id)
            next_status = next_e.get("status") or 0
            chain.append({"id": next_id, "url": next_e.get("url"), "status": next_status})
            if not (isinstance(next_status, int) and 300 <= next_status < 400):
                break
            raw2 = next_e.get("_raw", {}) or {}
            resp2 = raw2.get("response", {}) or {}
            redirect_url = resp2.get("redirectURL") or ""
            if not redirect_url:
                for h in (resp2.get("headers") or []):
                    if isinstance(h, dict) and (h.get("name") or "").lower() == "location":
                        redirect_url = h.get("value") or ""
                        break
        if len(chain) > 1:
            redirect_chains.append(chain)

    # ── Domain stats ───────────────────────────────────────────────────────
    domain_map: Dict[str, Dict[str, Any]] = {}
    for e in entries:
        try:
            host = urlparse(e.get("url", "")).netloc
        except Exception:
            host = ""
        if not host:
            continue
        if host not in domain_map:
            domain_map[host] = {"domain": host, "count": 0, "totalSize": 0, "totalTime": 0.0, "errorCount": 0}
        domain_map[host]["count"] += 1
        domain_map[host]["totalSize"] += int(e.get("size") or 0)
        domain_map[host]["totalTime"] += float(e.get("time") or 0)
        status = e.get("status") or 0
        if isinstance(status, int) and status >= 400:
            domain_map[host]["errorCount"] += 1
    domain_stats = sorted(domain_map.values(), key=lambda d: d["count"], reverse=True)

    # ── Summary ────────────────────────────────────────────────────────────
    total_count = len(entries)
    total_size = sum(int(e.get("size") or 0) for e in entries)
    total_time = sum(float(e.get("time") or 0) for e in entries)
    avg_time = total_time / total_count if total_count else 0.0
    error_count = len(error_requests)
    redirect_count = sum(
        1 for e in entries
        if isinstance(e.get("status"), int) and 300 <= e["status"] < 400
    )

    return {
        "summary": {
            "totalRequests": total_count,
            "totalSize": total_size,
            "totalTime": total_time,
            "avgTime": avg_time,
            "errorCount": error_count,
            "redirectCount": redirect_count,
            "domainCount": len(domain_map),
        },
        "slowRequests": slow_requests,
        "largeResponses": large_responses,
        "errorRequests": error_requests,
        "redirectChains": redirect_chains,
        "domainStats": domain_stats,
    }


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