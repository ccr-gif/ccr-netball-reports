// indexing test commit
// src/screens/Reports.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, Alert,
  Dimensions, useWindowDimensions, Platform
} from 'react-native';
import {
  getMatch, getMatchTotalsByQuarter, getPlayersMap,
  getPositionModeByQuarter, getQuarterScorelines, getBadPassByQuarter,
  getTeamFlowByQuarter,
} from '../storage/repository';
import * as FileSystem from 'expo-file-system/legacy';
import { WebView } from 'react-native-webview';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import * as MailComposer from 'expo-mail-composer';

import { colors } from '../theme';

// Outbox and uploader
import { queueReport, processOutbox, removeFromOutbox } from '../storage/reportOutbox';
import { uploadReportAndLog } from '../storage/uploadReport';

// Offline email prompt
import EmailPrompt from '../components/EmailPrompt';

// NEW imports for dynamic columns (Step 8)
import { getMatchConfig } from '../storage/matchConfig';
import { getAllTallies } from '../storage/customStatTallies';
import { getStatLibrary } from '../storage/customStats';
import {
  BUILTIN_TO_REPORT_FIELD,
  RowLike,
  STAT_LABEL,
  StatId,
} from '../types/stats';

const FORCE_SUPABASE_FOLDER: string | null = 'Netball_Games';

type Row = {
  player_id: string;
  period_id: string;

  attempts: number;
  goals: number;

  assists: number;
  feeds: number;

  rebound_off: number;
  rebound_def: number;

  cpr: number;
  penalties: number;
  to_won: number;
  to_lost: number;
  interceptions: number;

  bad_pass: number; // always merged separately
};

type TeamFlow = {
  cp_to_score: number;
  cp_no_score: number;
  to_to_score: number;
};

const POSITIONS_ORDER = ['GS','GA','WA','C','WD','GD','GK'] as const;

export default function Reports({ matchId }: { matchId?: string | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [heading, setHeading] = useState<{ title: string; sub: string }>({ title: '', sub: '' });
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  const [posMode, setPosMode] = useState<Record<string, Record<string, string>>>({});
  const [scorelines, setScorelines] = useState<Record<string, { home: number; away: number }>>({});
  const [homeName, setHomeName] = useState('Home');
  const [awayName, setAwayName] = useState('Away');
  const [matchDate, setMatchDate] = useState<string>('');
  const [teamFlowMap, setTeamFlowMap] = useState<Record<string, TeamFlow>>({});

  // Final folder used for Supabase
  const [cloudFolder, setCloudFolder] = useState<string>('no-match');

  // Offline prompt
  const [askEmailVisible, setAskEmailVisible] = useState(false);
  const [pendingReportData, setPendingReportData] = useState<any>(null);

  // NEW: dynamic stat columns & custom tallies
  const [enabledStats, setEnabledStats] = useState<StatId[]>([]);
  const [customTallies, setCustomTallies] = useState<{ player: any; team: any }>({ player: {}, team: {} });
  const libLabelsRef = useRef<Record<string, string>>({});

  // Screen/orientation
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const [orientationKey, setOrientationKey] = useState(0);
  useEffect(() => {
    const sub = Dimensions.addEventListener('change', () => setOrientationKey(k => k + 1));
    return () => { /* @ts-ignore */ sub?.remove?.(); };
  }, []);

  // Orientation handling
  const lockRetryRef = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const allowLandscape = async () => {
      try {
        await ScreenOrientation.unlockAsync();
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.ALL_BUT_UPSIDE_DOWN);
      } catch {
        lockRetryRef.current = setTimeout(async () => {
          if (cancelled) return;
          try {
            await ScreenOrientation.unlockAsync();
            await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.ALL_BUT_UPSIDE_DOWN);
            setOrientationKey(k => k + 1);
          } catch {}
        }, 50) as unknown as number;
      }
    };
    allowLandscape();
    return () => {
      cancelled = true;
      if (lockRetryRef.current) { clearTimeout(lockRetryRef.current); lockRetryRef.current = null; }
      (async () => {
        try {
          await ScreenOrientation.unlockAsync();
          await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
        } catch {}
      })();
    };
  }, []);

  const showHeader = !isLandscape;

  const insets = useSafeAreaInsets();
  const NAV_EST = 56;
  const bottomSpacer = isLandscape ? NAV_EST + (insets?.bottom ?? 0) : 0;

  // Players map
  useEffect(() => {
    (async () => {
      const map: any = await getPlayersMap();
      const nm: Record<string, string> = {};
      Object.values(map).forEach((p: any) => { nm[p.id] = p.name; });
      setNameMap(nm);
    })();
  }, []);

  // Load match + rows + pos + scorelines + team flow
  useEffect(() => {
    (async () => {
      if (!matchId) {
        setRows([]); setHeading({ title: '', sub: '' });
        setPosMode({}); setScorelines({}); setTeamFlowMap({});
        setHomeName('Home'); setAwayName('Away'); setMatchDate('');
        setCloudFolder(resolveFolder(null, null)); // use forced folder if set
        return;
      }
      const m: any = await getMatch(matchId);

      const parts: string[] = [];
      if (m?.match_date) parts.push(m.match_date);
      if (m?.competition) parts.push(m.competition);
      if (m?.venue) parts.push(m.venue);
      const subClean = parts.join(' - ');
      const title = m ? `${m.home_team ?? 'Home'} vs ${m.away_team ?? 'Away'}` : `Match ${String(matchId).slice(0, 6)}…`;

      setHeading({ title, sub: subClean });
      if (m) {
        setHomeName(m.home_team || 'Home');
        setAwayName(m.away_team || 'Away');
        setMatchDate(m.match_date || '');
      }

      // Decide the Supabase folder
      setCloudFolder(resolveFolder(m, matchId));

      const base: any[] = await getMatchTotalsByQuarter(matchId);

      const bads: any[] = await getBadPassByQuarter(matchId);
      const bpMap: Record<string, number> = {};
      for (const r of bads) bpMap[`${r.period_id}|${r.player_id}`] = (r.bad_passes ?? 0) as number;

     const merged: Row[] = base.map((r: any) => {
  const key = `${r.period_id}|${r.player_id}`;
  return {
    player_id: r.player_id,
    period_id: r.period_id,

    attempts: r.attempts || 0,
    goals: r.goals || 0,

    assists: r.assists || 0,
    feeds: r.feeds || 0,

    rebound_off: r.rebound_off || 0,
    rebound_def: r.rebound_def || 0,

    cpr: r.cpr || 0,
    penalties: r.penalties || 0,
    to_won: r.to_won || 0,
    to_lost: r.to_lost || 0,
    interceptions: r.interceptions || 0,

    bad_pass: bpMap[key] ?? 0,
  };
});


// rows that only have bad_pass (no other stats)
for (const r of bads) {
  const key = `${r.period_id}|${r.player_id}`;
  if (!merged.some(x => `${x.period_id}|${x.player_id}` === key)) {
    merged.push({
      player_id: r.player_id,
      period_id: r.period_id,

      attempts: 0,
      goals: 0,

      assists: 0,
      feeds: 0,

      rebound_off: 0,
      rebound_def: 0,

      cpr: 0,
      penalties: 0,
      to_won: 0,
      to_lost: 0,
      interceptions: 0,

      bad_pass: r.bad_passes || 0,
    });

        }
      }
      setRows(merged);

      const pm = await getPositionModeByQuarter(matchId);
      setPosMode(pm);

      const sl: any[] = await getQuarterScorelines(matchId);
      const sMap: Record<string, { home: number; away: number }> = {};
      sl.forEach((r: any) => (sMap[r.period_id] = { home: r.home, away: r.away }));
      setScorelines(sMap);

      // team flow
      try {
        const tflow: any[] = await getTeamFlowByQuarter(matchId);
        const tf: Record<string, TeamFlow> = {};
        for (const r of tflow) {
          tf[r.period_id] = {
            cp_to_score: r.cp_to_score || 0,
            cp_no_score: r.cp_no_score || 0,
            to_to_score: r.to_to_score || 0,
          };
        }
        setTeamFlowMap(tf);
      } catch {
        setTeamFlowMap({});
      }
    })();
  }, [matchId]);

  // Group by quarter
  const grouped = useMemo(() => {
    const map: Record<string, Row[]> = {};
    for (const r of rows) {
      const k = r.period_id || 'Q?';
      (map[k] ||= []).push(r);
    }
    return map;
  }, [rows]);

  // Sorting helper
  const posIndex = (p?: string | null) => {
    const i = POSITIONS_ORDER.indexOf((p || '') as any);
    return i === -1 ? 999 : i;
  };

  const firstCellClass = 'freeze';
  const firstTh = 'freeze';

  const getSortedRows = (q: string) => {
    const arr = [...(grouped[q] ?? [])];
    arr.sort((a, b) => {
      const pa = posMode[q]?.[a.player_id] || '';
      const pb = posMode[q]?.[b.player_id] || '';
      const ia = posIndex(pa);
      const ib = posIndex(pb);
      if (ia !== ib) return ia - ib;
      const na = (nameMap[a.player_id] || '').toLowerCase();
      const nb = (nameMap[b.player_id] || '').toLowerCase();
      return na.localeCompare(nb);
    });
    return arr;
  };

  const quarters = useMemo(() => Object.keys(grouped).sort(), [grouped]);

  // Final score
  const finalHome = (['Q1','Q2','Q3','Q4'] as const).reduce((acc, q) => acc + (scorelines[q]?.home ?? 0), 0);
  const finalAway = (['Q1','Q2','Q3','Q4'] as const).reduce((acc, q) => acc + (scorelines[q]?.away ?? 0), 0);

  /** -------------------------------------------------------------
   * Dynamic columns (built-ins + custom) from per-match selection
   * ------------------------------------------------------------- */

  // Load enabled stats + labels + custom tallies for this match
  useEffect(() => {
    (async () => {
      if (!matchId) {
        setEnabledStats([]);
        setCustomTallies({ player: {}, team: {} });
        libLabelsRef.current = {};
        return;
      }
      const [cfg, lib, tallies] = await Promise.all([
        getMatchConfig(String(matchId)),
        getStatLibrary(),
        getAllTallies(String(matchId)),
      ]);

      // labels for custom ids
      libLabelsRef.current = {};
      lib.forEach(item => { libLabelsRef.current[item.id] = item.label; });

      // union across positions + team

const enabled = new Set<StatId>();

// all player stats selected for this match
(cfg.player || []).forEach(s => enabled.add(s));

// all team stats selected
(cfg.team || []).forEach(s => enabled.add(s));

const flow = cfg.teamFlowEnabled || {};
if (flow.cp_to_score) enabled.add('cp_to_score');
if (flow.cp_no_score)  enabled.add('cp_no_score');
if (flow.to_to_score)  enabled.add('to_to_score');


// default fallback
if (enabled.size === 0) {
  enabled.add('goal');
  enabled.add('miss');
}

setEnabledStats(Array.from(enabled));
setCustomTallies(tallies);

    })();
  }, [matchId]);

  type Col = {
    key: string;
    label: string;
    value: (r: RowLike, q: string, playerId: string) => number | string;
    classOf?: (r: RowLike | any, v: number) => string | undefined; // for color classes (optional)
  };

function buildColumns(enabled: StatId[]): Col[] {
  const cols: Col[] = [];

  // Convert incoming list to a Set for fast lookup
  const enabledSet = new Set(enabled);


  // -----------------------------------------------
  // SHOOTING BLOCK (Always: Attempts, Goals, Goal %)
  // -----------------------------------------------
  const wantsShooting = enabled.includes('goal') || enabled.includes('miss');
  if (wantsShooting) {
    cols.push(
      { key: 'attempts', label: 'Attempts', value: r => r.attempts || 0 },
      { key: 'goals',    label: 'Goals',    value: r => r.goals || 0 },
      {
        key: 'goalPct',
        label: 'Goal %',
        value: r => (r.attempts ? Math.round((100 * r.goals) / r.attempts) : 0),
      }
    );
  }

  // ---------------------------------------------------------
  // BUILT‑IN STAT ORDER — OLD REPORT ORDER (Option 1 chosen)
  //
  // 1. Attempts, Goals, Goal%   (added above)
  // 2. Bad Pass
  // 3. Penalties
  // 4. Stepping (assist)
  // 5. Feeds
  // 6. Centre Pass Receives
  // 7. Interceptions
  // 8. Turnovers Won
  // 9. Turnovers Lost
  // 10. Rebounds Offence (new)
  // 11. Rebounds Defence (new)
  // ---------------------------------------------------------
  const preferredOrder: StatId[] = [
    'bad_pass',
    'penalty',
    'assist',       // displayed as “Stepping”
    'feed',
    'cpr',
    'interception',
    'to_won',
    'to_lost',
    'rebound_off', // NEW COLUMN
    'rebound_def', // NEW COLUMN
  ];

  for (const id of preferredOrder) {
    if (!enabledSet.has(id)) continue;
    const field = BUILTIN_TO_REPORT_FIELD[id];
    if (!field) continue;

    cols.push({
      key: id,
      label: STAT_LABEL[id] ?? String(id),
      value: r => r[field] || 0,
      classOf: (r, v) => {
        if (id === 'bad_pass' && v > 0) return 'bad';
        if (id === 'penalty'  && v > 0) return 'pen';
        if (id === 'assist'   && v > 0) return 'step';
        return undefined;
      }
    });
  }

  // -----------------------------------
  // CUSTOM STATS (dynamic, user‑created)
  // -----------------------------------
  for (const id of enabled) {
    if (!String(id).startsWith('custom:')) continue;
    const label = libLabelsRef.current[id] ?? 'Custom';
    cols.push({
      key: String(id),
      label,
      value: (_ignored, q, playerId) => {
        const row = customTallies.player?.[`${q}|${playerId}`];
        return row?.[id] || 0;
      },
    });
  }



// --- TEAM CUSTOM STATS (add columns for team-level custom stats) ---
for (const id of enabled) {
  // Only process team custom stats — adjust the condition based on your app:
  // OPTION A: if your team custom stat IDs use "team:" prefix:
  //   if (!String(id).startsWith('team:')) continue;
  //
  // OPTION B: if team custom stats also use "custom:" prefix but are stored in cfg.team:
  //   if (!cfg.team?.includes(id)) continue;

  // Example: Assuming OPTION B (most common in Netball Coach):
  if (!cfg.team?.includes(id)) continue;

  const label = libLabelsRef.current[id] ?? 'Team Stat';

  cols.push({
    key: String(id),
    label,

    // Team stats do NOT depend on playerId
    value: (_ignored, q) => {
      const row = customTallies.team?.[q];
      return row?.[id] || 0;
    },
  });
}


    return cols;
  }

  /** ---------- CSV (dynamic) ---------- */
  const csv = (cfg) => {
    const cols = buildColumns(enabledStats);
    const titleLine = ['Match', heading.title, heading.sub].join(',');
    const finalLine = ['Final', `${homeName} ${finalHome}-${finalAway} ${awayName}`].join(',');
    const scoreParts: string[] = ['Score by quarter'];
    (['Q1','Q2','Q3','Q4'] as const).forEach(q => {
      const s = scorelines[q]; scoreParts.push(`${q} ${s ? `${s.home}-${s.away}` : '0-0'}`);
    });
    const scoreLine = scoreParts.join(',');

    const header = ['Quarter','Player','Position', ...cols.map(c => c.label)].join(',');
    const lines: string[] = [titleLine, finalLine, scoreLine, header];

    for (const q of quarters) {
      const data = getSortedRows(q);

      // Player rows
      for (const r of data) {
        const nm = nameMap[r.player_id] || r.player_id;
        const pos = posMode[q]?.[r.player_id] || '';
        const cells = cols.map(c => String(c.value(r, q, r.player_id) ?? ''));
        lines.push([q, nm, pos, ...cells].join(','));
      }

      // Totals row — compute per-column sums (goalPct special)
      const totals = data.reduce((acc, r) => {
        acc.attempts += r.attempts || 0;
        acc.goals    += r.goals || 0;
        return acc;
      }, { attempts: 0, goals: 0 });

      
const totalCells = cols.map(c => {
  if (c.key === 'goalPct') {
    return totals.attempts ? Math.round((100 * totals.goals) / totals.attempts) : 0;
  }

  // sum the column across rows
  const total = data.reduce((acc, r) => {
    const v = Number(c.value(r, q, r.player_id) || 0);
    return acc + v;
  }, 0);

  return total;
});

      lines.push([q, 'Total', '', ...totalCells].join(','));

      // Team row: only team flow values (kept separate from the dynamic columns)
      const tf = teamFlowMap[q] || { cp_to_score: 0, cp_no_score: 0, to_to_score: 0 };
      

// ---- TEAM ROW (CSV) ----
const teamCells: string[] = [];

// 1. Quarter
teamCells.push(q);

// 2. Row label
teamCells.push("Team");

// 3. Position column (always blank)
teamCells.push("");

// 4. Dynamic columns (match order in buildColumns)
for (const c of cols) {
  // TEAM custom stats (cfg.team contains only team stat IDs)
  if (Array.isArray(cfg.team) && cfg.team.includes(c.key)) {
    const value = customTallies.team?.[q]?.[c.key] ?? 0;
    teamCells.push(String(value));
  } else {
    // Player stat → blank for team row
    teamCells.push("");
  }
}

// 5. Append team flow stats (always at the end)
teamCells.push(String(tf.cp_to_score));
teamCells.push(String(tf.cp_no_score));
teamCells.push(String(tf.to_to_score));

// Insert into CSV
lines.push(teamCells.join(','));



      lines.push('');
    }
    return lines.join('\n');
  };

  /** ---------- HTML (dynamic) ---------- */
  const html = () => {
    const cols = buildColumns(enabledStats);

    const qScore = (q: string) => {
      const s = scorelines[q] || { home: 0, away: 0 };
      return `${s.home}-${s.away}`;
    };

    const baseFont = isLandscape ? 12 : 14;
    const cellPad = isLandscape ? '6px 8px' : '8px 10px';
    const playerMin = isLandscape ? 110 : 90;
    const hideHeadMeta = isLandscape;

    const stickyHeaderCss = isLandscape ? '' : `
      th { position: sticky; top: 0; z-index: 3; }
      th.freeze { z-index: 4; }`;
    const stickyFirstColCss = `
      th.freeze, td.freeze {
        position: sticky; left: 0; z-index: 3;
        background: #10172a; box-shadow: 1px 0 0 0 #1e293b; will-change: transform;
      }
      thead th.freeze { z-index: 4; }`;
    const alignAndColorCss = `
      th.num, td.num { text-align: center; }
      td.bad { color: #ef4444; font-weight: 800; }
      td.pen { color: #ef4444; font-weight: 800; }
      td.step { color: #ef4444; font-weight: 800; }
      .teamRow td { background: rgba(14,165,233,0.08); }
      .totalRow td { background: rgba(120,113,108,0.10); }
      .totalName, .teamName { font-weight: 800; }
    `;
    const wrapperCss = isLandscape
      ? `.grid { overflow:auto; -webkit-overflow-scrolling:touch; touch-action:pan-x pan-y; position:relative; max-height:100%; }`
      : `.hscroll{overflow-x:auto;-webkit-overflow-scrolling:touch;position:relative;} .table-viewport{overflow:auto;max-height:440px;}`;

    const head = `
<!DOCTYPE html><html><head><meta charset="utf-8" />
<title>${heading.title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<style>
  :root { --brand: ${colors.primary || '#2563eb'}; --bg: #0b1020; --panel: #10172a; --muted: #cbd5e1; --line: #1e293b; }
  html,body { margin:0; padding:0; background: var(--bg); color:#e2e8f0; font: ${baseFont}px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; height: 100%; }
  .wrap { padding: ${isLandscape ? '10px' : '16px'}; }

  .title, .sub, .final, .scores { ${hideHeadMeta ? 'display:none !important;' : ''} }

  .card { background: #10172a; border: 1px solid var(--line); border-radius: 12px; padding: ${isLandscape ? '6px' : '10px'}; margin: ${isLandscape ? '6px 0' : '10px 0'}; }
  .q { font-weight: 800; margin: 0 0 ${isLandscape ? '4px' : '6px'}; }

  ${wrapperCss}
  ${stickyHeaderCss}
  ${stickyFirstColCss}
  ${alignAndColorCss}

  table { width: 100%; border-collapse: collapse; min-width: 1080px; }
  th, td { text-align: left; padding: ${cellPad}; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: #e2e8f0; background: #0f172a; }
  td { color: #e5edf6; }
  .pill { display:inline-block; padding: 2px 8px; border-radius: 999px; background: #0ea5e9; color:#001018; font-weight: 800; }
  .muted { color: var(--muted); }
</style>
</head><body style="height: 100%"><div class="wrap">
  <div class="title" style="font-weight:800; font-size:${baseFont + 6}px; margin:0 0 6px;">${heading.title}</div>
  <div class="sub" style="color:#cbd5e1; margin-bottom:10px;">${heading.sub}</div>
  <div class="final" style="background:linear-gradient(90deg,var(--brand),#8b5cf6); padding:8px 12px; border-radius:10px; font-weight:800; display:inline-block; margin: 6px 0 10px;">
    Final: ${homeName} ${finalHome}&nbsp;–&nbsp;${finalAway} ${awayName}
  </div>
  <div class="scores muted" style="margin-bottom:10px;">
    Q1 ${qScore('Q1')}&nbsp;&nbsp;&nbsp;Q2 ${qScore('Q2')}&nbsp;&nbsp;&nbsp;Q3 ${qScore('Q3')}&nbsp;&nbsp;&nbsp;Q4 ${qScore('Q4')}
  </div>
`;

    const thead = (): string => {
      const heads = cols.map(c => `<th class="num">${c.label}</th>`).join('');
      return `
        <thead>
          <tr>
            <th class="${firstTh}" style="min-width:${playerMin}px">Player</th>
            <th>Position</th>
            ${heads}
          </tr>
        </thead>`;
    };

    const rowsForQ = (q: string) => {
      const data = getSortedRows(q);


const tds = (r: Row): string => {
  return cols.map(c => {
    const v = Number(c.value(r, q, r.player_id) || 0);

    // This callback was defined in buildColumns()
    const cls = c.classOf?.(r, v);

    // Apply classes correctly
    return `<td class="num${cls ? ' ' + cls : ''}">${v}</td>`;
  }).join('');
};


      // Player rows
      const trs = data.map(r => {
        const nm = nameMap[r.player_id] || r.player_id;
        const pos = posMode[q]?.[r.player_id] || '—';
        return `<tr>
          <td class="${firstTh}">${nm}</td>
          <td><span class="pill">${pos}</span></td>
          ${tds(r)}
        </tr>`;
      }).join('');

      // Totals row
      // Compute totals (goalPct special)
      const totals = data.reduce((a, r) => {
        a.attempts += r.attempts || 0;
        a.goals    += r.goals || 0;
        return a;
      }, { attempts: 0, goals: 0 });


// ---- Correct Totals Row (HTML) ----
const totalCells = cols
  .map(c => {
    if (c.key === 'goalPct') {
      return totals.attempts
        ? Math.round((100 * totals.goals) / totals.attempts)
        : 0;
    }

    // Sum values for each column
    const sum = data.reduce((acc, r) => {
      const v = Number(c.value(r, q, r.player_id) || 0);
      return acc + v;
    }, 0);

    return sum;
  })
  
.map((sum, idx) => {
  const c = cols[idx];                      // the column
  const fakeRow: any = {};                 // dummy row for classOf()
  const cls = c.classOf                    // determine red-text class
    ? c.classOf({ [c.key]: sum }, sum) : '';
  return `<td class="num${cls ? ' ' + cls : ''}">${sum}</td>`;
})
.join('');



      const totalRow = `<tr class="totalRow">
        <td class="${firstTh} totalName">Total</td><td></td>
        ${totalCells}
      </tr>`;

      // Team row — only team flow (kept outside dynamic columns)
      const tf = teamFlowMap[q] || { cp_to_score: 0, cp_no_score: 0, to_to_score: 0 };
      const cpNoScoreClass = tf.cp_no_score > 0 ? 'num pen' : 'num';

const teamRow = `<tr class="teamRow">
  <td class="${firstTh} teamName">Team</td><td></td>
  
${cols.map(c => {
if (Array.isArray(cfg.team) && cfg.team.includes(c.key)) {
  const value = customTallies.team?.[q]?.[c.key] || 0;
  return `<td class="num">${value}</td>`;
}

// Player stat → leave blank for team row
return `<td class="num"></td>`;

}).join('')}

  <td class="num">${tf.cp_to_score}</td>
  <td class="${tf.cp_no_score > 0 ? 'num pen' : 'num'}">${tf.cp_no_score}</td>
  <td class="num">${tf.to_to_score}</td>
</tr>`;

      const s = scorelines[q] || { home: 0, away: 0 };

      if (isLandscape) {
        return `
        <div class="card qcard" id="q-${q}">
          <div class="q">${q} &nbsp; <span class="muted">(${s.home}–${s.away})</span></div>
          <div class="grid"><table>${thead()}<tbody>${trs}${totalRow}${teamRow}</tbody></table></div>
        </div>`;
      }
      return `
      <div class="card qcard" id="q-${q}">
        <div class="q">${q} &nbsp; <span class="muted">(${s.home}–${s.away})</span></div>
        <div class="hscroll"><div class="table-viewport"><table>${thead()}<tbody>${trs}${totalRow}${teamRow}</tbody></table></div></div>
      </div>`;
    };

    return head + quarters.map(rowsForQ).join('') + `</div></body></html>`;
  };

  // ---------- Email subject/body helpers (dd/mm/yyyy) ----------
  const subjectLine = () =>
    `Netball Report – ${heading.title}${matchDate ? ` – ${matchDate}` : ''}`;

  const toDDMMYYYY = (isoLike?: string): string => {
    if (!isoLike) return '';
    const d = new Date(isoLike);
    if (isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return `${dd}/${mm}/${yyyy}`;
  };

  const formatEmailBody = () => {
    const dateIso = matchDate || (heading.sub?.split(' - ')[0] ?? '').trim();
    const formatted = toDDMMYYYY(dateIso);
    const dateText = formatted || '';

    return [
      `Hi,`,
      ``,
      `Attached is the report for ${homeName} vs ${awayName} (${finalHome}-${finalAway})${dateText ? ` on ${dateText}` : ''}.`,
      ``,
      `Regards,`,
      `Netball Coach App`,
    ].join('\n');
  };

  // ---------- File creation (NO upload here; Outbox will upload) ----------
  const createFiles = async () => {
    const subject = subjectLine();
    const body = formatEmailBody();

    const baseSafe = (() => {
      const normalized = subject.normalize('NFKD')
        .replace(/[\u2012-\u2015]/g, '-')       // fancy dashes -> ascii
        .replace(/[\u2018-\u201F\u2032-\u2036]/g, ''); // quotes/primes -> remove
      let b = normalized
        .replace(/[^A-Za-z0-9\s\-_.]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/-+/g, '-')
        .replace(/^[_\-\.]+|[_\-\.]+$/g, '');
      if (!b) b = 'Netball_Report';
      if (b.length > 120) b = b.slice(0, 120);
      return b;
    })();

    // 🔒 Folder: prefer FORCE_SUPABASE_FOLDER, else per-match legacy id
    const folder = resolveFolder(null, matchId)
      .replace(/^reports\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');

    // Friendly base only (no timestamp suffix)
    const storageKeyBase = `${folder}/${baseSafe}`;

    const csvBodyStr = csv(cfg);
    const htmlBodyStr = html();

    const csvUri = FileSystem.cacheDirectory + `${baseSafe}.csv`;
    const htmlUri = FileSystem.cacheDirectory + `${baseSafe}.html`;

    await FileSystem.writeAsStringAsync(csvUri, csvBodyStr);
    await FileSystem.writeAsStringAsync(htmlUri, htmlBodyStr);

    return { subject, body, csvUri, htmlUri, storageKeyBase };
  };

  // Email button: prompt + queue when offline; direct-send when online
  const email = async () => {
    try {
      if (!matchId) { Alert.alert('Select a match first'); return; }
      const { subject, body, csvUri, htmlUri, storageKeyBase } = await createFiles();

      const mailAvailable = await MailComposer.isAvailableAsync();
      const net = await NetInfo.fetch();
      const isOnline = !!net.isConnected;

      const outboxId = `rep_${matchId}_${Date.now()}`;

      if (isOnline) {
        // Always queue first (ensures nothing is lost)
        await queueReport({
          id: outboxId,
          matchId: matchId!,
          subject,
          body,
          csvUri,
          htmlUri,
          storageKeyBase,
          created: new Date().toISOString(),
          serverSend: false,    // online => direct send
          to: [], cc: [], bcc: [],
          openComposer: false,
        });

        if (!mailAvailable) {
          Alert.alert(
            'Mail not available',
            'The Mail app is not available on this device. The report has been saved and will send automatically when the device is online.'
          );
          processOutbox().catch(() => {});
          return;
        }

        // Direct send now: upload + open composer; then remove queued copy so we don't server-send later
        try {
          await directSendNow(matchId!, { csvUri, htmlUri, storageKeyBase, subject, body });
          await removeFromOutbox(outboxId);
        } catch (err: any) {
          Alert.alert('Could not open email', err?.message ?? 'We will retry via Outbox.');
          processOutbox().catch(() => {});
        }
        return;
      }

      // OFFLINE => ask for recipient email, then queue with serverSend:true
      setPendingReportData({ subject, body, csvUri, htmlUri, storageKeyBase, outboxId });
      setAskEmailVisible(true);

    } catch (e: any) {
      Alert.alert('Email failed', e?.message ?? 'Could not generate or queue the report.');
    }
  };

  // Direct-send path: upload now + open composer now
  // If uploads fail here, gracefully fall back to server-send so nothing is lost.
  async function directSendNow(
    matchId: string,
    opts: { csvUri: string; htmlUri: string; storageKeyBase: string; subject: string; body: string }
  ) {
    const { csvUri, htmlUri, storageKeyBase, subject, body } = opts;
    const base = storageKeyBase.replace(/^reports\//, '').replace(/\/+$/, '');
    const csvKey = `${base}.csv`;
    const htmlKey = `${base}.html`;

    try {
      await uploadReportAndLog(matchId, csvUri, csvKey, 'text/csv');    // upsert true in uploader
      await uploadReportAndLog(matchId, htmlUri, htmlKey, 'text/html'); // upsert true in uploader

      await MailComposer.composeAsync({
        subject,
        body,
        attachments: [htmlUri, csvUri],
      });
    } catch (_e: any) {
      await queueReport({
        id: `retry_${matchId}_${Date.now()}`,
        matchId,
        subject,
        body,
        csvUri,
        htmlUri,
        storageKeyBase,
        created: new Date().toISOString(),
        serverSend: true,
        openComposer: false,
      });
      processOutbox().catch(() => {});
      Alert.alert('Saved for later', 'Network was unstable. We’ll send the email as soon as internet is stable.');
    }
  }

  const minWebViewHeight = Math.max(
    isLandscape ? 520 : 480,
    Dimensions.get('window').height - (isLandscape ? 140 : 230) - bottomSpacer
  );
  const webKey = `report-${matchId || 'none'}-${isLandscape ? 'land' : 'port'}-${orientationKey}-${quarters.join('-')}`;

  return (
    <View style={styles.container}>
      {showHeader && (
        <View style={styles.headRow}>
          <View style={styles.titleWrap}>
            <Text style={styles.h1} numberOfLines={2} ellipsizeMode="tail">
              {heading.title || 'Report by Quarter'}
            </Text>
            {!!heading.sub && <Text style={styles.sub}>{heading.sub}</Text>}
          </View>

          {/* EMAIL button only */}
          <Pressable style={styles.btnSmall} onPress={email} disabled={!matchId}>
            <Text style={styles.btnSmallText}>📨 Email</Text>
          </Pressable>
        </View>
      )}

      {!!matchId && (
        <>
          <View style={{ flex: 1, marginTop: showHeader ? 8 : 0, minHeight: minWebViewHeight }}>
            <WebView
              key={webKey}
              originWhitelist={['*']}
              source={{ html: html() }}
              style={{ flex: 1, borderRadius: showHeader ? 12 : 0, overflow: 'hidden', backgroundColor: '#0b1020' }}
              nestedScrollEnabled={false}
              showsVerticalScrollIndicator
              showsHorizontalScrollIndicator
            />
          </View>
          {isLandscape && <View style={{ height: bottomSpacer }} />}
        </>
      )}

      {/* Offline email prompt */}
      <EmailPrompt
        visible={askEmailVisible}
        onCancel={() => { setAskEmailVisible(false); setPendingReportData(null); }}
        onSubmit={async (email) => {
          setAskEmailVisible(false);
          if (!email || !email.includes('@')) {
            Alert.alert('Invalid email', 'Please enter a valid email address.');
            setPendingReportData(null);
            return;
          }
          const { subject, body, csvUri, htmlUri, storageKeyBase, outboxId } = pendingReportData || {};
          await queueReport({
            id: outboxId,
            matchId: matchId!,
            subject,
            body,
            csvUri,
            htmlUri,
            storageKeyBase,
            created: new Date().toISOString(),
            serverSend: true,
            to: [email],
            cc: [],
            bcc: [],
            openComposer: false,
          });
          setPendingReportData(null);
          Alert.alert('Saved for later', 'The report will be sent when the device is online.');
          processOutbox().catch(() => {});
        }}
      />
    </View>
  );
}

/**
 * Returns the effective folder to use:
 * - If FORCE_SUPABASE_FOLDER is set, always use that.
 * - Else, try server/legacy ids from the match row (supabase_id, uuid, etc.).
 * - Else, fall back to current matchId or 'no-match'.
 */
function resolveFolder(m: any | null, fallbackId: string | null | undefined): string {
  if (FORCE_SUPABASE_FOLDER && FORCE_SUPABASE_FOLDER.trim()) return FORCE_SUPABASE_FOLDER.trim();
  const legacy =
    m?.supabase_id ||
    m?.remote_id ||
    m?.cloud_id ||
    m?.uuid ||
    fallbackId ||
    'no-match';
  return String(legacy);
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, backgroundColor: '#fff' },

  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    marginBottom: 6,
  },
  titleWrap: { flexShrink: 1, flexGrow: 1, paddingRight: 6, marginRight: 'auto' },

  h1: { fontSize: 15, fontWeight: '800', color: '#0f172a' },
  sub: { color: '#555', marginTop: 2 },

  btnSmall: {
    backgroundColor: colors.primary,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    minWidth: 86,
    alignItems: 'center',
    ...(Platform.OS === 'android'
      ? { elevation: 1 }
      : {
          shadowColor: '#000',
          shadowOpacity: 0.12,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 2 },
        }),
  },
  btnSmallText: { color: '#fff', fontWeight: '900', fontSize: 13 },
});
``
