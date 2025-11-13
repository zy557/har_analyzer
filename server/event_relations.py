from typing import Any, Dict, List, Optional, Tuple


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


def build_event_graph(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Construct a simple event relation graph from HAR entries using heuristics:
    - Nodes: one per entry with timing and meta fields
    - Edges: from initiator URL -> entry (best-effort URL match),
             otherwise from first document of same host -> entry

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

        # Edge inference
        initiator_url = _get_initiator_url(e)
        src_id: Optional[int] = None
        reason: str = ""
        if initiator_url and initiator_url in url_to_id:
            src_id = url_to_id[initiator_url]
            reason = "initiator"
        else:
            host = e.get("host")
            if host and host in host_to_first_doc and host_to_first_doc[host] != eid:
                src_id = host_to_first_doc[host]
                reason = "document"

        if src_id is not None:
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