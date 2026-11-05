import React from 'react';
import type { Activity } from './api.js';
const clock = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour12: false }); };
export function ActivityFeed({ role, activity }: { role: 'before' | 'after'; activity: Activity | null }) {
  const label = role === 'before' ? 'Before' : 'After';
  const rows = activity?.events.filter(e => e.role === role) ?? [];
  const blocked = rows.filter(r => r.action).length;
  return <div className="activity" aria-label={`${label} recent requests`}>
    <h4>Recent requests <span className="small muted">Cloudflare log, last {activity?.windowMinutes ?? 30} min</span></h4>
    {!activity ? <p className="small muted" role="status">Loading the request log&hellip;</p>
      : !activity.available ? <p className="small muted" role="status">{activity.reason ?? 'Request log unavailable'}</p>
      : rows.length === 0 ? <p className="small muted" role="status">No requests in the last {activity.windowMinutes} minutes.</p>
      : <>
        <p className="activity-count"><strong>{rows.length - blocked}</strong> served &middot; <strong className={blocked ? 'blocked-count' : ''}>{blocked}</strong> blocked</p>
        <ul>{rows.slice(0, 8).map((r, i) => <li key={`${r.rayId ?? i}-${r.time}`} className={r.action ? 'blocked' : 'served'}><time>{clock(r.time)}</time><code>{r.path}</code><span className="chip">{r.status}</span><span>{r.action ? `Blocked at the edge (${r.action})` : r.reachedOrigin ? 'Served by origin' : 'Served'}</span></li>)}</ul>
      </>}
  </div>;
}
