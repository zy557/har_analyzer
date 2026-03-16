from typing import Any, Dict, List, Optional, Set, Tuple


def _to_int(v: Any, default: int = 0) -> int:
    try:
        return int(v) if v is not None else default
    except Exception:
        return default


def _to_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v) if v is not None else default
    except Exception:
        return default


def _get_initiator_url(e: Dict[str, Any]) -> Optional[str]:
    ini = e.get("initiator")
    if not ini:
        return None
    # common shapes from Chrome DevTools HAR
    if isinstance(ini, dict):
        if "url" in ini and isinstance(ini["url"], str):
            return ini["url"]
        # sometimes under stack.callFrames[0].url
        try:
            frames = ini.get("stack", {}).get("callFrames", [])
            if frames and isinstance(frames[0].get("url"), str):
                return frames[0]["url"]
        except Exception:
            pass
    if isinstance(ini, str):
        return ini
    return None


def _get_initiator_type(e: Dict[str, Any]) -> str:
    """Return the initiator type string from HAR entry, or empty string if not present."""
    ini = e.get("initiator")
    if isinstance(ini, dict):
        t = ini.get("type")
        if isinstance(t, str):
            return t.lower()
    return ""


def _classify_reason(ini_type: str, resource_type: str) -> str:
    """Map initiator type + resource type to an edge reason label.

    Returns one of: 'parser', 'script', 'redirect', 'preload', 'prefetch', 'xhr', 'document'.
    """
    if ini_type == "parser":
        return "parser"
    if ini_type == "script":
        return "script"
    if ini_type == "redirect":
        return "redirect"
    if ini_type in ("preload", "prefetch"):
        return ini_type
    if resource_type in ("xhr", "fetch"):
        return "xhr"
    return "document"


def build_event_graph(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Construct an event relation graph from HAR entries using heuristics:
    - Nodes: one per entry with timing and meta fields
    - Edges: inferred from initiator type/URL, redirect chains, and host-document fallback

    Reason values on edges: parser | script | redirect | preload | prefetch | xhr | document

    Returns: { nodes: [...], edges: [...] }
    """
    id_map: Dict[int, Dict[str, Any]] = {}
    url_to_id: Dict[str, int] = {}
    host_to_first_doc: Dict[str, int] = {}

    for e in entries:
        eid = _to_int(e.get("id"))
        id_map[eid] = e
        url = e.get("url") or ""
        if url:
            url_to_id[url] = eid
        if (e.get("resourceType") or "") == "document" and e.get("host") and e.get("host") not in host_to_first_doc:
            host_to_first_doc[e.get("host")] = eid

    # Build redirect chain: a 3xx response whose Location header matches the next request URL
    redirect_target_to_source: Dict[int, Tuple[int, str]] = {}
    for e in entries:
        eid = _to_int(e.get("id"))
        raw = e.get("_raw", {}) or {}
        resp = raw.get("response", {}) or {}
        status = _to_int(resp.get("status") or e.get("status"), 0)
        if 300 <= status < 400:
            redirect_url = resp.get("redirectURL") or ""
            if not redirect_url:
                # fall back to Location header value
                for h in (resp.get("headers") or []):
                    if isinstance(h, dict) and (h.get("name") or "").lower() == "location":
                        redirect_url = h.get("value") or ""
                        break
            if redirect_url and redirect_url in url_to_id:
                target_id = url_to_id[redirect_url]
                redirect_target_to_source[target_id] = (eid, "redirect")

    edge_set: Set[Tuple[int, int, str]] = set()
    nodes = []
    edges: List[Dict[str, Any]] = []

    for e in entries:
        eid = _to_int(e.get("id"))
        start = _to_float(e.get("started_ms"), 0.0)
        dur = _to_float(e.get("time"), 0.0)
        end = start + dur
        nodes.append(
            {
                "id": eid,
                "url": e.get("url"),
                "host": e.get("host"),
                "path": e.get("path"),
                "type": e.get("resourceType"),
                "method": e.get("method"),
                "status": e.get("status"),
                "size": _to_int(e.get("size"), 0),
                "start": start,
                "end": end,
            }
        )

        src_id: Optional[int] = None
        reason: str = ""

        # 1. Redirect chain takes highest priority
        if eid in redirect_target_to_source:
            src_id, reason = redirect_target_to_source[eid]

        # 2. Initiator-based detection
        if src_id is None:
            ini_type = _get_initiator_type(e)
            resource_type = e.get("resourceType") or ""
            initiator_url = _get_initiator_url(e)

            if ini_type in ("parser", "script", "preload", "prefetch", "redirect"):
                if initiator_url and initiator_url in url_to_id:
                    src_id = url_to_id[initiator_url]
                    reason = _classify_reason(ini_type, resource_type)
                elif initiator_url:
                    # initiator URL not in graph (e.g. external document) – still record reason
                    # but we need a node; fall through to host-doc fallback
                    reason = _classify_reason(ini_type, resource_type)
            elif ini_type:
                # unknown non-empty type
                if initiator_url and initiator_url in url_to_id:
                    src_id = url_to_id[initiator_url]
                    reason = _classify_reason(ini_type, resource_type)
            else:
                # No initiator type but URL provided
                if initiator_url and initiator_url in url_to_id:
                    src_id = url_to_id[initiator_url]
                    reason = _classify_reason("", resource_type)

        # 3. Fallback: first document on same host
        if src_id is None:
            host = e.get("host")
            if host and host in host_to_first_doc and host_to_first_doc[host] != eid:
                src_id = host_to_first_doc[host]
                reason = reason or "document"

        if src_id is not None:
            key = (src_id, eid, reason)
            if key not in edge_set:
                edge_set.add(key)
                edges.append({"source": src_id, "target": eid, "reason": reason})

    return {"nodes": nodes, "edges": edges}


def build_phase_stats(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Aggregate timing segments across entries and by resource type.
    Returns overall totals and per-type breakdown.
    """
    phases = ["blocked", "dns", "connect", "ssl", "send", "wait", "receive"]
    total: Dict[str, float] = {p: 0.0 for p in phases}
    by_type: Dict[str, Dict[str, float]] = {}

    for e in entries:
        segs = e.get("timingSegments") or {}
        rtype = e.get("resourceType") or "unknown"
        if rtype not in by_type:
            by_type[rtype] = {p: 0.0 for p in phases}
        for p in phases:
            v = _to_float(segs.get(p), 0.0)
            total[p] += v
            by_type[rtype][p] += v

    return {"total": total, "byType": by_type}