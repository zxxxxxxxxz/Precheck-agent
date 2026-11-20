import React from 'react';

/** Shared preparation labels; receipt status belongs to the current round. */
export function MaterialChecklistTitle({label, englishLabel, condition}: {label: string; englishLabel: string; condition: string}) {
  return <div className="preparation-row-title"><strong>{label}</strong><p><span lang="en">{englishLabel}</span><br/>{condition}</p></div>;
}
