// src/screens/HistoryReports.tsx
import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, Pressable, Platform, Modal, TextInput,
  FlatList, Dimensions, Alert, useWindowDimensions
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system/legacy';
import * as MailComposer from 'expo-mail-composer';
import { colors } from '../theme';
import {
  listAllMatchesBasic,
  getMatchTotalsByQuarter,
  getPlayersMap,
  getPositionModeByQuarter,
  getQuarterScorelines,
  getBadPassByQuarter,
  getTeamFlowByQuarter,
} from '../storage/repository';
import { initDb, run } from '../storage/db';

// NEW dynamic imports
import { getMatchConfig } from '../storage/matchConfig';
import { getAllTallies } from '../storage/customStatTallies';
import { getStatLibrary } from '../storage/customStats';
import {
  BUILTIN_TO_REPORT_FIELD,
  RowLike,
  STAT_LABEL,
  StatId,
} from '../types/stats';

type Row = {
  player_id: string;
  period_id: string;
  attempts: number;
  goals: number;
  assists: number;
  feeds: number;
  rebounds: number;
  cpr: number;
  penalties: number;
  to_won: number;
  to_lost: number;
  interceptions: number;
  bad_pass: number;
};

type TeamFlow = {
  cp_to_score: number;
  cp_no_score: number;
  to_to_score: number;
};

const POSITIONS_ORDER = ['GS','GA','WA','C','WD','GD','GK'] as const;

export default function HistoryReports() {
  // Matches list + selection
  const [matches, setMatches] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Report data
  const [rows, setRows] = useState<Row[]>([]);
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  const [posMode, setPosMode] = useState<Record<string, Record<string, string>>>({});
  const [scorelines, setScorelines] = useState<Record<string, { home: number; away: number }>>({});
  const [homeName, setHomeName] = useState('Home');
  const [awayName, setAwayName] = useState('Away');
  const [matchDate, setMatchDate] = useState<string>('');
  const [heading, setHeading] = useState<{ title: string; sub: string }>({ title: '', sub: '' });
  const [teamFlowMap, setTeamFlowMap] = useState<Record<string, TeamFlow>>({});

  // NEW dynamic column state
  const [enabledStats, setEnabledStats] = useState<StatId[]>([]);
  const [customTallies, setCustomTallies] = useState<{ player: any; team: any }>({ player: {}, team: {} });
  const libLabelsRef = useRef<Record<string, string>>({});

  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  // Load matches (most recent first) + preselect latest
  useEffect(() => {
    (async () => {
      const list = await listAllMatchesBasic();
      setMatches(list);
      if (list.length && !selectedId) setSelectedId(list[0].id);
    })();
  }, []);

  // Players map
  useEffect(() => {
    (async () => {
      const map: any = await getPlayersMap();
      const nm: Record<string, string> = {};
      Object.values(map).forEach((p: any) => (nm[p.id] = p.name));
      setNameMap(nm);
    })();
  }, []);

  // Load report data for selected match
  useEffect(() => {
    (async () => {
      if (!selectedId) {
        setRows([]); setPosMode({}); setScorelines({});
        setTeamFlowMap({}); setHomeName('Home'); setAwayName('Away'); setMatchDate('');
        setHeading({ title: '', sub: '' });
        setEnabledStats([]); setCustomTallies({ player:{}, team:{} }); libLabelsRef.current = {};
        return;
      }

      const m = matches.find(x => x.id === selectedId);
      if (m) {
        setHomeName(m.home_team || 'Home');
        setAwayName(m.away_team || 'Away');
        setMatchDate(m.match_date || '');
        const subParts: string[] = [];
        if (m.match_date) subParts.push(m.match_date);
        if (m.competition) subParts.push(m.competition);
        if (m.venue) subParts.push(m.venue);
        setHeading({ title: `${m.home_team ?? 'Home'} vs ${m.away_team ?? 'Away'}`, sub: subParts.join(' - ') });
      }

      const base: any[] = await getMatchTotalsByQuarter(selectedId);

      const bads: any[] = await getBadPassByQuarter(selectedId);
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
          rebounds: r.rebounds || 0,
          cpr: r.cpr || 0,
          penalties: r.penalties || 0,
          to_won: r.to_won || 0,
          to_lost: r.to_lost || 0,
          interceptions: r.interceptions || 0,
          bad_pass: bpMap[key] ?? 0,
        };
      });

      // rows with only bad_pass
      for (const r of bads) {
        const key = `${r.period_id}|${r.player_id}`;
        if (!merged.some(x => `${x.period_id}|${x.player_id}` === key)) {
          merged.push({
            player_id: r.player_id,
            period_id: r.period_id,
            attempts: 0, goals: 0, assists: 0, feeds: 0, rebounds: 0,
            cpr: 0, penalties: 0, to_won: 0, to_lost: 0, interceptions: 0,
            bad_pass: r.bad_passes || 0,
          });
        }
      }
      setRows(merged);

      const pm = await getPositionModeByQuarter(selectedId);
      setPosMode(pm);

      const sl: any[] = await getQuarterScorelines(selectedId);
      const sMap: Record<string, { home: number; away: number }> = {};
      sl.forEach((r: any) => (sMap[r.period_id] = { home: r.home, away: r.away }));
      setScorelines(sMap);

      // team flow
      try {
        const tflow: any[] = await getTeamFlowByQuarter(selectedId);
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

      // load per-match config + library + tallies
      const [cfg, lib, tallies] = await Promise.all([
        getMatchConfig(String(selectedId)),
        getStatLibrary(),
        getAllTallies(String(selectedId)),
      ]);
      libLabelsRef.current = {};
      lib.forEach(item => { libLabelsRef.current[item.id] = item.label; });

      const union = new Set<StatId>(cfg.team || []);
      Object.values(cfg.positions || {}).forEach(list => list?.forEach(s => union.add(s)));
      setEnabledStats(union.size ? Array.from(union) : ['goal','miss']);
      setCustomTallies(tallies);
    })();
  }, [selectedId, matches]);

  // group rows by quarter
  const grouped = useMemo(() => {
    const map: Record<string, Row[]> = {};
    for (const r of rows) {
      const k = r.period_id || 'Q?';
      (map[k] ||= []).push(r);
    }
    return map;
  }, [rows]);

  const quarters = useMemo(() => Object.keys(grouped).sort(), [grouped]);

  // final score
  const finalHome = (['Q1','Q2','Q3','Q4'] as const).reduce((acc, q) => acc + (scorelines[q]?.home ?? 0), 0);
  const finalAway = (['Q1','Q2','Q3','Q4'] as const).reduce((acc, q) => acc + (scorelines[q]?.away ?? 0), 0);

  // sorting helper by position order
  const posIndex = (p?: string | null) => {
    const i = POSITIONS_ORDER.indexOf((p || '') as any);
    return i === -1 ? 999 : i;
  };

  // ---------- Dynamic columns ----------
  type Col = {
    key: string;
    label: string;
    value: (r: RowLike, q: string, playerId: string) => number | string;
  };

  function buildColumns(enabled: StatId[]): Col[] {
    const cols: Col[] = [];
    const wantsShooting = enabled.includes('goal') || enabled.includes('miss');
    if (wantsShooting) {
      cols.push(
        { key: 'attempts', label: 'Attempts', value: (r) => r.attempts || 0 },
        { key: 'goals',    label: 'Goals',    value: (r) => r.goals || 0 },
        { key: 'goalPct',  label: 'Goal %',   value: (r) => (r.attempts ? Math.round((100 * r.goals) / r.attempts) : 0) },
      );
    }
    for (const id of enabled) {
      if (id === 'goal' || id === 'miss') continue;
      if (!String(id).startsWith('custom:')) {
        const field = BUILTIN_TO_REPORT_FIELD[id as any];
        if (!field) continue;
        cols.push({
          key: String(id),
          label: STAT_LABEL[id as any] ?? String(id),
          value: (r: any) => r[field] || 0,
        });
      } else {
        const label = libLabelsRef.current[id] ?? 'Custom';
        cols.push({
          key: String(id),
          label,
          value: (_r, q, playerId) => {
            const row = customTallies.player?.[`${q}|${playerId}`];
            return row?.[id as any] || 0;
          },
        });
      }
    }
    return cols;
  }

  // ===== CSV (dynamic) =====
  const csvBody = () => {
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
      const arr = (grouped[q] ?? []).slice();
      arr.sort((a, b) => {
        const pa = posMode[q]?.[a.player_id] || '';
        const pb = posMode[q]?.[b.player_id] || '';
        const ia = posIndex(pa), ib = posIndex(pb);
        if (ia !== ib) return ia - ib;
        const na = (nameMap[a.player_id] || '').toLowerCase();
        const nb = (nameMap[b.player_id] || '').toLowerCase();
        return na.localeCompare(nb);
      });

      // Player rows
      for (const r of arr) {
        const nm = nameMap[r.player_id] || r.player_id;
        const pos = posMode[q]?.[r.player_id] || '';
        const cells = cols.map(c => String(c.value(r, q, r.player_id) ?? ''));
        lines.push([q, nm, pos, ...cells].join(','));
      }

      // Totals
      const totals = arr.reduce((a, r) => {
        a.attempts += r.attempts || 0;
        a.goals    += r.goals || 0;
        return a;
      }, { attempts: 0, goals: 0 });
      const totalCells = cols.map(c => {
        if (c.key === 'goalPct') {
          return totals.attempts ? Math.round((100 * totals.goals) / totals.attempts) : 0;
        }
        const s = arr.reduce((acc, r) => acc + Number(c.value(r as any, q, r.player_id) || 0), 0);
        return s;
      });
      lines.push([q, 'Total', '', ...totalCells].join(','));

      // Team row — only team flow values (kept separate)
      const tf = teamFlowMap[q] || { cp_to_score: 0, cp_no_score: 0, to_to_score: 0 };
      lines.push([q, 'Team', '', ...Array(cols.length).fill(''), tf.cp_to_score, tf.cp_no_score, tf.to_to_score].join(','));

      lines.push('');
    }
    return lines.join('\n');
  };

  // ===== HTML (dynamic) =====
  const htmlBody = () => {
    const cols = buildColumns(enabledStats);
    const baseFont = isLandscape ? 12 : 14;
    const cellPad = isLandscape ? '6px 8px' : '8px 10px';
    const playerMin = isLandscape ? 110 : 90;

    // Sticky header only in portrait
    const stickyHeaderCss = isLandscape ? '' : `
      th { position: sticky; top: 0; z-index: 3; }
      th.freeze { z-index: 4; }`;

    // Sticky first column (Player) in both orientations
    const stickyFirstColCss = `
      th.freeze, td.freeze {
        position: sticky; left: 0; z-index: 3;
        background: #10172a;
        box-shadow: 1px 0 0 0 #1e293b;
        will-change: transform;
      }
      thead th.freeze { z-index: 4; }`;

    const alignAndColorCss = `
      th.num, td.num { text-align: center; }
      .teamRow td { background: rgba(14,165,233,0.08); }
      .totalRow td { background: rgba(120,113,108,0.10); }
      .totalName, .teamName { font-weight: 800; }
    `;

    // Scrollers
    const wrapperCss = isLandscape
      ? `
        .grid {
          overflow: auto;
          -webkit-overflow-scrolling: touch;
          touch-action: pan-x pan-y;
          position: relative;
          max-height: 100%;
        }`
      : `
        .hscroll { overflow-x:auto; -webkit-overflow-scrolling: touch; position: relative; }
        .table-viewport { overflow:auto; max-height: 440px; }`;

    const qScore = (q: string) => {
      const s = scorelines[q] || { home: 0, away: 0 };
      return `${s.home}–${s.away}`;
    };

    const head = `
<!DOCTYPE html><html><head><meta charset="utf-8" />
<title>${heading.title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<style>
  :root { --brand: ${colors.primary || '#2563eb'}; --bg: #0b1020; --panel: #10172a; --muted: #cbd5e1; --line: #1e293b; }
  html,body { margin:0; padding:0; background: var(--bg); color:#e2e8f0; font: ${baseFont}px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; }
  .wrap { padding: ${isLandscape ? '10px' : '16px'}; }
  .title { font-weight:800; font-size:${baseFont + 6}px; margin:0 0 6px; }
  .sub { color:#cbd5e1; margin-bottom:10px; }
  .final { background:linear-gradient(90deg,var(--brand),#8b5cf6); padding:8px 12px; border-radius:10px; font-weight:800; display:inline-block; margin: 6px 0 10px; }
  .scores { color:#cbd5e1; margin-bottom:10px; }

  .card { background: #10172a; border: 1px solid var(--line); border-radius: 12px; padding: ${isLandscape ? '6px' : '10px'}; margin: ${isLandscape ? '6px 0' : '10px 0'}; }
  .q { font-weight: 800; margin: 0 0 ${isLandscape ? '4px' : '6px'}; }

  ${wrapperCss}

  table { width: 100%; border-collapse: collapse; min-width: 1080px; }
  th, td { text-align: left; padding: ${cellPad}; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: #e2e8f0; background: #0f172a; }

  ${stickyHeaderCss}
  ${stickyFirstColCss}
  ${alignAndColorCss}

  td { color: #e5edf6; }
  .pill { display:inline-block; padding: 2px 8px; border-radius: 999px; background: #0ea5e9; color:#001018; font-weight: 800; }
  .muted { color: var(--muted); }
</style></head><body><div class="wrap">
  <div class="title">${heading.title}</div>
  <div class="sub">${heading.sub}</div>
  <div class="final">Final: ${homeName} ${finalHome}&nbsp;–&nbsp;${finalAway} ${awayName}</div>
  <div class="scores">Q1 ${qScore('Q1')}&nbsp;&nbsp;Q2 ${qScore('Q2')}&nbsp;&nbsp;Q3 ${qScore('Q3')}&nbsp;&nbsp;Q4 ${qScore('Q4')}</div>
`;

    const thead = (): string => {
      const heads = buildColumns(enabledStats).map(c => `<th class="num">${c.label}</th>`).join('');
      return `
        <thead>
          <tr>
            <th class="freeze" style="min-width:${playerMin}px">Player</th>
            <th>Position</th>
            ${heads}
          </tr>
        </thead>`;
    };

    const bodyForQ = (q: string) => {
      const arr = (grouped[q] ?? []).slice();
      arr.sort((a, b) => {
        const pa = posMode[q]?.[a.player_id] || '';
        const pb = posMode[q]?.[b.player_id] || '';
        const ia = posIndex(pa), ib = posIndex(pb);
        if (ia !== ib) return ia - ib;
        const na = (nameMap[a.player_id] || '').toLowerCase();
        const nb = (nameMap[b.player_id] || '').toLowerCase();
        return na.localeCompare(nb);
      });

      const cols = buildColumns(enabledStats);
      const tds = (r: Row): string =>
        cols.map(c => `<td class="num">${Number(c.value(r, q, r.player_id) || 0)}</td>`).join('');

      const trs = arr.map(r => {
        const nm = nameMap[r.player_id] || r.player_id;
        const pos = posMode[q]?.[r.player_id] || '—';
        return `<tr>
          <td class="freeze">${nm}</td>
          <td><span class="pill">${pos}</span></td>
          ${tds(r)}
        </tr>`;
      }).join('');

      // totals
      const totals = arr.reduce((a, r) => {
        a.attempts += r.attempts || 0;
        a.goals    += r.goals || 0;
        return a;
      }, { attempts: 0, goals: 0 });

      const totalCells = cols.map(c => {
        if (c.key === 'goalPct') {
          return totals.attempts ? Math.round((100 * totals.goals) / totals.attempts) : 0;
        }
        const s = arr.reduce((acc, r) => acc + Number(c.value(r as any, q, r.player_id) || 0), 0);
        return s;
      }).map(v => `<td class="num">${v}</td>`).join('');

      const totalRow = `<tr class="totalRow">
        <td class="freeze totalName">Total</td>
        <td></td>
        ${totalCells}
      </tr>`;

      const tf = teamFlowMap[q] || { cp_to_score: 0, cp_no_score: 0, to_to_score: 0 };
      const teamRow = `<tr class="teamRow">
        <td class="freeze teamName">Team</td>
        <td></td>
        ${Array(cols.length).fill('<td class="num"></td>').join('')}
        <td class="num">${tf.cp_to_score}</td>
        <td class="num">${tf.cp_no_score}</td>
        <td class="num">${tf.to_to_score}</td>
      </tr>`;

      const s = scorelines[q] || { home: 0, away: 0 };

      if (isLandscape) {
        return `
        <div class="card">
          <div class="q">${q} &nbsp; <span class="muted">(${s.home}–${s.away})</span></div>
          <div class="grid">
            <table>
              ${thead()}
              <tbody>${trs}${totalRow}${teamRow}</tbody>
            </table>
          </div>
        </div>`;
      }

      return `
      <div class="card">
        <div class="q">${q} &nbsp; <span class="muted">(${s.home}–${s.away})</span></div>
        <div class="hscroll">
          <div class="table-viewport">
            <table>
              ${thead()}
              <tbody>${trs}${totalRow}${teamRow}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    };

    return head + quarters.map(bodyForQ).join('') + `</div></body></html>`;
  };

  // Email helpers
  const sanitizeFilename = (s: string) => {
    const asciiDash = /[\u2012\u2013\u2014\u2015]/g;
    const smartQuotes = /[\u2018\u2019\u201A\u201B\u2032\u2035\u201C\u201D\u201E\u201F\u2033\u2036]/g;
    const normalized = s.replace(asciiDash, '-').replace(smartQuotes, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    let b = normalized.replace(/[^A-Za-z0-9\s\-_.]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/-+/g, '-').replace(/^[_\-\.]+|[_\-\.]+$/g, '');
    if (!b) b = 'Netball_Report';
    return b.slice(0, 120);
  };

  const emailFiles = async () => {
    if (!selectedId) return;
    const subject = `Netball Report – ${heading.title}${matchDate ? ` – ${matchDate}` : ''}`;
    const base = sanitizeFilename(subject);
    const csv = csvBody();
    const html = htmlBody();
    const csvUri = FileSystem.cacheDirectory + `${base}.csv`;
    const htmlUri = FileSystem.cacheDirectory + `${base}.html`;
    await FileSystem.writeAsStringAsync(csvUri, csv);
    await FileSystem.writeAsStringAsync(htmlUri, html);
    const ok = await MailComposer.isAvailableAsync();
    if (!ok) {
      alert('Mail not available. Please configure a mail account on this device.');
      return;
    }
    await MailComposer.composeAsync({
      subject,
      body: 'Attached: HTML report (with colors) and CSV (for spreadsheets).',
      attachments: [htmlUri, csvUri],
    });
  };

  // Delete selected match (and all related rows)
  const deleteSelected = async () => {
    if (!selectedId) return;
    Alert.alert(
      'Delete match',
      'This will permanently delete the match and all its stats and lineups. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await initDb();
              await run(`delete from event where match_id=?`, [selectedId]);
              await run(`delete from lineup_player where lineup_id in (select id from lineup where match_id=?)`, [selectedId]);
              await run(`delete from lineup where match_id=?`, [selectedId]);
              await run(`delete from period where match_id=?`, [selectedId]);
              await run(`delete from match where id=?`, [selectedId]);

              const list = await listAllMatchesBasic();
              setMatches(list);
              setSelectedId(list.length ? list[0].id : null);

              if (!list.length) {
                setRows([]); setPosMode({}); setScorelines({}); setTeamFlowMap({});
                setHomeName('Home'); setAwayName('Away'); setMatchDate('');
                setHeading({ title: '', sub: '' });
                setEnabledStats([]); setCustomTallies({ player:{}, team:{} }); libLabelsRef.current = {};
              }
              Alert.alert('Match deleted', 'The match and its data have been removed.');
            } catch (e: any) {
              Alert.alert('Delete failed', e?.message ?? 'Could not delete this match.');
            }
          }
        }
      ]
    );
  };

  // Full searchable dropdown (modal)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return matches;
    return matches.filter(m => {
      const title = `${m.home_team ?? ''} vs ${m.away_team ?? ''} ${m.match_date ?? ''} ${m.competition ?? ''} ${m.venue ?? ''}`.toLowerCase();
      return title.includes(q);
    });
  }, [matches, query]);

  const currentTitle = useMemo(() => {
    const m = matches.find(x => x.id === selectedId);
    if (!m) return 'Select a match';
    const title = `${m.home_team ?? 'Home'} vs ${m.away_team ?? 'Away'}`;
    return m.match_date ? `${title} • ${m.match_date}` : title;
  }, [matches, selectedId]);

  const minWebViewHeight = Math.max(
    isLandscape ? 520 : 480,
    Dimensions.get('window').height - (isLandscape ? 120 : 220) - 60
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.topRow}>
        <Text style={styles.h1}>Game History</Text>
        <View style={styles.actionsRow}>
          <Pressable style={[styles.btnSm, styles.btnDanger]} onPress={deleteSelected} disabled={!selectedId}>
            <Text style={styles.btnSmText}>🗑 Delete</Text>
          </Pressable>
          <Pressable style={[styles.btnSm, styles.btnPrimary]} onPress={emailFiles} disabled={!selectedId}>
            <Text style={styles.btnSmText}>📨 Email</Text>
          </Pressable>
        </View>
      </View>

      {/* Full dropdown (searchable) */}
      <Text style={styles.label}>Match</Text>
      <Pressable style={styles.dropdown} onPress={() => setPickerOpen(true)}>
        <Text style={styles.dropdownText} numberOfLines={1}>{currentTitle}</Text>
        <Text style={styles.dropdownIcon}>▾</Text>
      </Pressable>

      <Modal visible={pickerOpen} animationType="slide" onRequestClose={() => setPickerOpen(false)} transparent>
        <View style={styles.modalWrap}>
          <View style={styles.sheet}>
            <Text style={styles.modalTitle}>Select a match</Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search team, date, competition, venue…"
              style={styles.search}
              autoCorrect={false}
            />
            <FlatList
              data={filtered}
              keyExtractor={(i) => i.id}
              renderItem={({ item }) => {
                const title = `${item.home_team ?? 'Home'} vs ${item.away_team ?? 'Away'}`;
                const sub = [item.match_date, item.competition, item.venue].filter(Boolean).join(' • ');
                const on = item.id === selectedId;
                return (
                  <Pressable
                    onPress={() => { setSelectedId(item.id); setPickerOpen(false); setQuery(''); }}
                    style={[styles.rowItem, on && styles.rowItemOn]}
                  >
                    <Text style={[styles.rowItemTitle, on && styles.rowItemTitleOn]} numberOfLines={1}>{title}</Text>
                    {!!sub && <Text style={[styles.rowItemSub, on && styles.rowItemSubOn]} numberOfLines={1}>{sub}</Text>}
                  </Pressable>
                );
              }}
              ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
              style={{ maxHeight: 380 }}
            />
            <View style={{ height: 10 }} />
            <Pressable style={[styles.btnLg, styles.btnPrimary]} onPress={() => setPickerOpen(false)}>
              <Text style={styles.btnLgText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Report WebView */}
      {!!selectedId && (
        <View style={{ flex: 1, marginTop: 8, minHeight: minWebViewHeight }}>
          <WebView
            originWhitelist={['*']}
            source={{ html: htmlBody() }}
            style={{ flex: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0b1020' }}
            nestedScrollEnabled={!isLandscape}
            showsVerticalScrollIndicator
            showsHorizontalScrollIndicator
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, backgroundColor: '#fff' },

  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  h1: { fontSize: 18, fontWeight: '800', color: '#0f172a' },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  // Small buttons in header
  btnSm: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, minWidth: 92,
    alignItems: 'center', justifyContent: 'center',
    ...(Platform.OS === 'android'
      ? { elevation: 1 }
      : { shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } }),
  },
  btnSmText: { color: '#fff', fontWeight: '900' },
  btnPrimary: { backgroundColor: colors.primary },
  btnDanger: { backgroundColor: '#dc2626' },

  label: { color: '#334155', fontWeight: '700', marginTop: 8, marginBottom: 4 },

  dropdown: {
    borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff'
  },
  dropdownText: { color: '#0f172a', fontWeight: '700', flexShrink: 1, paddingRight: 10 },
  dropdownIcon: { color: '#64748b' },

  // Modal sheet
  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', padding: 14, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  modalTitle: { fontSize: 16, fontWeight: '800', color: '#0f172a', marginBottom: 8 },

  search: {
    borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, color: '#0f172a', marginBottom: 10
  },

  rowItem: {
    borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#f8fafc'
  },
  rowItemOn: { backgroundColor: '#e0e7ff', borderColor: '#c7d2fe' },
  rowItemTitle: { fontWeight: '900', color: '#0f172a' },
  rowItemTitleOn: { color: '#111827' },
  rowItemSub: { color: '#64748b', marginTop: 2 },
  rowItemSubOn: { color: '#334155' },

  // Large button inside modal
  btnLg: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  btnLgText: { color: '#fff', fontWeight: '900' },
});