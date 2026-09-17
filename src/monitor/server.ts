/**
 * Tiny `node:http` server for the live monitor: `GET /` serves a self-contained dark-theme page
 * that polls `/api/status` every 2 s, `GET /api/status` returns {@link BotStats.snapshot} as
 * JSON, `GET /metrics` the Prometheus exposition, everything else 404. It binds to 127.0.0.1
 * unless told otherwise; there is no authentication, so expose it only through an SSH tunnel.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { BotStats } from './stats.js'

export interface MonitorServerOptions {
  /** 0 picks a free port (its number is in the returned `url`). */
  port: number
  /** Default `127.0.0.1`. */
  host?: string
  /** Block explorer base for transaction links (default Arc mainnet's). */
  explorerUrl?: string
}

export interface MonitorServer {
  url: string
  port: number
  close(): Promise<void>
}

const DEFAULT_EXPLORER = 'https://explorer.arc.io'

export async function startMonitorServer(stats: BotStats, opts: MonitorServerOptions): Promise<MonitorServer> {
  const host = opts.host ?? '127.0.0.1'
  const explorer = opts.explorerUrl ?? DEFAULT_EXPLORER
  const page = renderPage(explorer)
  const server: Server = createServer((req, res) => handle(req, res, stats, page))
  server.keepAliveTimeout = 5_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : opts.port
  const shownHost = host.includes(':') ? `[${host}]` : host
  return {
    url: `http://${shownHost}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}

function handle(req: IncomingMessage, res: ServerResponse, stats: BotStats, page: string): void {
  const path = (req.url ?? '/').split('?')[0]
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'method not allowed\n')
    return
  }
  try {
    if (path === '/' || path === '/index.html') send(res, 200, 'text/html; charset=utf-8', page)
    else if (path === '/api/status') send(res, 200, 'application/json; charset=utf-8', JSON.stringify(stats.snapshot()))
    else if (path === '/metrics') send(res, 200, 'text/plain; version=0.0.4; charset=utf-8', stats.toPrometheus())
    else if (path === '/healthz') send(res, 200, 'text/plain; charset=utf-8', 'ok\n')
    else send(res, 404, 'text/plain; charset=utf-8', 'not found\n')
  } catch (error) {
    send(res, 500, 'text/plain; charset=utf-8', `error: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** The monitor page. Inline CSS and JS only; `explorer` is embedded as a JSON string literal (with `<` escaped so it cannot close the script). */
export function renderPage(explorer: string): string {
  const explorerLiteral = JSON.stringify(explorer).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARC-MEV monitor</title>
<style>
:root{color-scheme:dark;--bg:#111211;--panel:#1a1a19;--panel2:#222321;--line:#2e2f2d;--ink:#ececea;--ink2:#a8a9a5;--muted:#77786f;--accent:#7cb0ff;--good:#0ca30c;--warn:#fab219;--serious:#ec835a;--bad:#d03b3b;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;margin-bottom:12px}
header h1{font-size:18px;margin:0;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--ink2);font-size:12px;white-space:nowrap}
.chip b{color:var(--ink);font-weight:600}
.chip .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.dot.good{background:var(--good)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.dot.serious{background:var(--serious)}
.stale{color:var(--serious);font-size:12px;display:none}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:12px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-width:0}
.tile .label{color:var(--ink2);font-size:12px}
.tile .value{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile .sub{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.value.pos{color:#7fd27f}.value.neg{color:#f08a8a}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
@media (max-width:760px){.grid{grid-template-columns:1fr}}
section.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-width:0}
section.panel h2{font-size:13px;font-weight:600;color:var(--ink2);margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-variant-numeric:tabular-nums}
.kv dt{color:var(--ink2);margin:0}.kv dd{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meter{height:10px;border-radius:5px;background:#1f2d40;overflow:hidden;margin:6px 0}
.meter>i{display:block;height:100%;background:var(--accent);border-radius:5px;transition:width .4s}
.meter>i.warn{background:var(--warn)}.meter>i.bad{background:var(--bad)}
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--ink2);font-weight:500;font-size:12px}
td.num,th.num{text-align:right}
td.cycle{font-family:var(--mono);font-size:12px;max-width:520px;overflow:hidden;text-overflow:ellipsis}
td.mono{font-family:var(--mono);font-size:12px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:12px;border:1px solid var(--line);color:var(--ink2)}
.tag.good{color:#7fd27f;border-color:#2f5a2f}.tag.bad{color:#f08a8a;border-color:#5a2f2f}.tag.warn{color:#f5c65c;border-color:#5a4a1f}.tag.serious{color:var(--serious);border-color:#5a3a2a}
.empty{color:var(--muted);padding:8px 0}
footer{color:var(--muted);font-size:12px;margin-top:8px}
</style>
</head>
<body>
<main>
<header>
  <h1>ARC-MEV</h1>
  <div class="chips" id="chips"></div>
  <span class="stale" id="stale">status feed stale</span>
</header>
<div class="tiles" id="tiles"></div>
<div class="grid">
  <section class="panel"><h2>Gate</h2><div id="gate"></div></section>
  <section class="panel"><h2>Latency (ms, last 600 blocks)</h2><div class="tablewrap"><table><thead><tr><th>stage</th><th class="num">p50</th><th class="num">p90</th><th class="num">max</th><th class="num">n</th></tr></thead><tbody id="latency"></tbody></table></div></section>
</div>
<section class="panel" style="margin-bottom:12px"><h2>Last opportunities</h2><div class="tablewrap"><table><thead><tr><th>time</th><th>block</th><th>cycle</th><th class="num">amountIn</th><th class="num">expected</th><th class="num">net</th><th>probed</th><th>simulated</th></tr></thead><tbody id="opps"></tbody></table></div><div class="empty" id="opps-empty">none yet</div></section>
<section class="panel"><h2>Last sends</h2><div class="tablewrap"><table><thead><tr><th>time</th><th>block</th><th>hash</th><th class="num">tip (gwei)</th><th>outcome</th><th class="num">profit</th><th class="num">fee</th><th>mined</th></tr></thead><tbody id="sends"></tbody></table></div><div class="empty" id="sends-empty">none yet</div></section>
<footer>Polling <code>/api/status</code> every 2 s. Prometheus text at <a href="/metrics">/metrics</a>. Bound to localhost; tunnel to view remotely.</footer>
</main>
<script>
(function(){
var EXPLORER=${explorerLiteral};
var $=function(id){return document.getElementById(id)};
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function n(x,d){return Number(x).toLocaleString(undefined,{maximumFractionDigits:d==null?2:d})}
function usdc(m){return m?n(m.usdc,4):'-'}
function signed(m){var v=Number(m.usdc);return (v>0?'+':'')+n(v,4)}
function uptime(s){var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),x=s%60;return (d?d+'d ':'')+(d||h?h+'h ':'')+(d||h||m?m+'m ':'')+x+'s'}
function ago(iso){if(!iso)return '-';var s=Math.max(0,Math.round((Date.now()-Date.parse(iso))/1000));return s<60?s+'s ago':s<3600?Math.floor(s/60)+'m ago':Math.floor(s/3600)+'h ago'}
function hhmmss(iso){var d=new Date(iso);return d.toTimeString().slice(0,8)}
function short(h){return h.slice(0,10)+'\\u2026'+h.slice(-6)}
function tile(label,value,sub,cls){return '<div class="tile"><div class="label">'+esc(label)+'</div><div class="value '+(cls||'')+'">'+value+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>'}
function chip(label,value,dot){return '<span class="chip">'+(dot?'<span class="dot '+dot+'"></span>':'')+esc(label)+' <b>'+value+'</b></span>'}
function cls(m){var v=Number(m.usdc);return v>0?'pos':v<0?'neg':''}
function render(s){
  var st=s.static||{},head=s.head,g=s.gate,c=s.counts;
  var mode=head?head.mode:'?',modeDot=mode==='ws'?'good':mode==='ws-stalled'?'warn':'serious';
  $('chips').innerHTML=chip('chain',esc(st.chainId||'?'))+chip('mode',st.dryRun===false?'LIVE':'DRY RUN',st.dryRun===false?'bad':'good')
    +chip('head',esc(mode)+(head?' ('+head.liveSubscriptions+' ws)':''),modeDot)
    +chip('executor',st.executor?'<span title="'+esc(st.executor)+'">'+esc(short(st.executor))+'</span>':'none')
    +chip('pools',esc(st.trackedPools||0)+' / '+esc(st.probePools||0)+' probed')+chip('cycles',esc(st.cycles||0));
  var wr=s.winRate==null?'-':n(s.winRate*100,1)+'%';
  $('tiles').innerHTML=
    tile('Profit today',usdc(s.profit.today),'total '+usdc(s.profit.total)+' \\u00b7 1h '+usdc(s.profit.lastHour),cls(s.profit.today))
   +tile('Gas paid today',usdc(s.gasPaid.today),'total '+usdc(s.gasPaid.total)+' \\u00b7 1h '+usdc(s.gasPaid.lastHour))
   +tile('Net today',signed(s.net.today),'total '+signed(s.net.total)+' \\u00b7 1h '+signed(s.net.lastHour),cls(s.net.today))
   +tile('Sends',n(c.sends,0),n(c.wins,0)+' won \\u00b7 '+n(c.reverts,0)+' reverted \\u00b7 '+n(c.lost,0)+' lost'+(c.pending?' \\u00b7 '+c.pending+' pending':''))
   +tile('Win rate',wr,n(c.wins+c.reverts+c.lost,0)+' settled')
   +tile('Would send',n(c.dryRunWouldSend,0),'dry-run '+c.wouldSendByReason['dry-run']+' \\u00b7 outbid '+(c.wouldSendByReason.outbid||0)+' \\u00b7 gate '+(c.wouldSendByReason.breaker+c.wouldSendByReason['gas-budget'])+' \\u00b7 in-flight '+c.wouldSendByReason['in-flight'])
   +tile('Blocks / min',n(s.blocksPerMinute,0),n(s.blocksProcessed,0)+' processed'+(s.errors?' \\u00b7 '+s.errors+' errors':''))
   +tile('Last block',s.lastBlock==null?'-':esc(s.lastBlock),ago(s.lastBlockAt)+(head&&head.newest?' \\u00b7 head '+esc(head.newest):''))
   +tile('Opportunities',n(c.opportunities,0),n(c.candidates,0)+' cleared gas')
   +tile('Uptime',uptime(s.uptimeSeconds),'since '+hhmmss(s.startedAt));
  if(g){var pct=g.budgetUsedPct,mcls=pct>=100?'bad':pct>=75?'warn':'';
    $('gate').innerHTML='<dl class="kv"><dt>breaker</dt><dd>'+(g.breakerPaused?'<span class="tag bad">paused until block '+esc(g.pausedUntilBlock)+'</span>':'<span class="tag good">closed</span>')+' \\u00b7 '+g.consecutiveFailures+' consecutive failures</dd>'
      +'<dt>gas budget</dt><dd>'+usdc(g.budgetSpent)+' / '+usdc(g.budgetLimit)+' USDC in the last '+n(g.windowBlocks,0)+' blocks ('+n(pct,1)+'%)</dd></dl>'
      +'<div class="meter"><i class="'+mcls+'" style="width:'+Math.min(100,pct)+'%"></i></div>'
      +(pct>=100?'<div class="tag bad">budget exhausted: dry-run only</div>':'')
      +(s.market?'<dl class="kv"><dt>market tip</dt><dd>'+(s.market.required?'a send must bid <b>'+esc(s.market.required.gwei)+' gwei</b>':'gate off')+' \\u00b7 top tips of the last '+s.market.blocks+' blocks: p50 '+esc(s.market.p50?s.market.p50.gwei:'-')+' \\u00b7 p75 '+esc(s.market.p75?s.market.p75.gwei:'-')+' \\u00b7 p90 '+esc(s.market.p90?s.market.p90.gwei:'-')+' gwei</dd></dl>':'');
  } else $('gate').innerHTML='<div class="empty">no gate status yet</div>';
  $('latency').innerHTML=s.latency.map(function(r){return '<tr><td>'+esc(r.stage)+'</td><td class="num">'+n(r.p50,1)+'</td><td class="num">'+n(r.p90,1)+'</td><td class="num">'+n(r.max,1)+'</td><td class="num">'+r.samples+'</td></tr>'}).join('');
  var opps=s.lastOpportunities;$('opps-empty').style.display=opps.length?'none':'';
  $('opps').innerHTML=opps.map(function(o){var sim=o.simulated?(o.simulated.ok?'<span class="tag good">ok'+(o.simulated.profit?' '+usdc(o.simulated.profit):'')+'</span>':'<span class="tag bad" title="'+esc(o.simulated.reason||'')+'">'+esc((o.simulated.reason||'failed').slice(0,60))+'</span>'):'<span class="tag">-</span>';
    return '<tr><td>'+hhmmss(o.at)+'</td><td>'+esc(o.block)+'</td><td class="cycle" title="'+esc(o.cycle)+'">'+esc(o.cycle)+'</td><td class="num">'+esc(o.amountIn)+'</td><td class="num">'+usdc(o.expected)+'</td><td class="num">'+usdc(o.net)+'</td><td>'+(o.probed?'yes':'no')+'</td><td>'+sim+'</td></tr>'}).join('');
  var sends=s.lastSends;$('sends-empty').style.display=sends.length?'none':'';
  $('sends').innerHTML=sends.map(function(x){var oc=x.outcome==='success'?'good':x.outcome==='reverted'?'bad':x.outcome==='lost'?'serious':'warn';
    return '<tr><td>'+hhmmss(x.at)+'</td><td>'+esc(x.block)+'</td><td class="mono"><a href="'+esc(EXPLORER)+'/tx/'+esc(x.hash)+'" target="_blank" rel="noopener">'+esc(short(x.hash))+'</a></td><td class="num">'+n(x.tip.gwei,0)+'</td><td><span class="tag '+oc+'">'+esc(x.outcome)+(x.reason?' ('+esc(x.reason)+')':'')+'</span></td><td class="num">'+(x.profit?usdc(x.profit):'-')+'</td><td class="num">'+(x.feePaid?usdc(x.feePaid):'-')+'</td><td>'+(x.minedBlock?esc(x.minedBlock):'-')+'</td></tr>'}).join('');
}
var failures=0;
function tick(){fetch('/api/status',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(function(s){failures=0;$('stale').style.display='none';render(s)}).catch(function(){failures++;if(failures>=2)$('stale').style.display=''})}
tick();setInterval(tick,2000);
})();
</script>
</body>
</html>
`
}
