import { useEffect, useMemo, useState } from 'react'

/* ============================================================
   GROUND-UP REDESIGN SHOWCASE  —  three concepts, self-contained.
   Visit /redesign?c=halo | ledger | manuscript  (default: halo)
   Each concept reinvents the INPUT element + the message model,
   not just the palette. Sample data only — no gateway plumbing.
   ============================================================ */

type Concept = 'halo' | 'ledger' | 'manuscript'

const CONCEPTS: { id: Concept; label: string }[] = [
  { id: 'halo', label: 'Halo' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'manuscript', label: 'Manuscript' },
]

/* shared sample conversation so the three are directly comparable */
const SAMPLE = {
  user1: 'What’s the status on the MoveKit billing fix?',
  agent: 'jinn-dev',
  agentEmoji: '\u{1F9D1}‍\u{1F4BB}',
  reply:
    'The AVS / billing-address fix shipped to all MoveKit Checkout Sessions — `billing_address_collection: "required"`. Conversion held flat through the first 48 hours, so no regression. I’ve queued the 30-day review for June 17. Want me to wire a PostHog funnel alert in the meantime?',
  tools: 4,
  agents: [
    { id: 'jimbo', emoji: '\u{1F3A9}', name: 'Jimbo', state: 'idle' },
    { id: 'jinn-dev', emoji: '\u{1F9D1}‍\u{1F4BB}', name: 'Jinn Dev', state: 'working' },
    { id: 'pravko', emoji: '⚖️', name: 'Pravko Lead', state: 'idle' },
    { id: 'movekit', emoji: '\u{1F4E6}', name: 'MoveKit Support', state: 'working' },
    { id: 'cos', emoji: '\u{1F4CB}', name: 'Chief of Staff', state: 'idle' },
  ],
}

/* ---------- HALO : spatial / ambient / floating island input ---------- */
function Halo({ empty }: { empty: boolean }) {
  const [text, setText] = useState(empty ? '' : 'Draft the PostHog funnel alert')
  return (
    <div className="halo-root">
      {/* ambient agent rail */}
      <div className="halo-rail">
        <div className="halo-mark">✶</div>
        {SAMPLE.agents.map((a) => (
          <div key={a.id} className={`halo-orb ${a.state === 'working' ? 'is-working' : ''}`} title={a.name}>
            <span>{a.emoji}</span>
            {a.state === 'working' && <i className="halo-pulse" />}
          </div>
        ))}
        <div className="halo-rail-spacer" />
        <div className="halo-orb halo-orb-ghost">⊕</div>
      </div>

      <div className="halo-stage">
        {empty ? (
          <div className="halo-hero">
            <div className="halo-hero-title">Good evening, Hristo.</div>
            <div className="halo-hero-sub">Five employees on shift · two working now</div>
          </div>
        ) : (
          <div className="halo-thread">
            <div className="halo-turn halo-turn-user">
              <p>{SAMPLE.user1}</p>
            </div>
            <div className="halo-turn halo-turn-agent">
              <div className="halo-gutter"><span>{SAMPLE.agentEmoji}</span></div>
              <div className="halo-msg">
                <div className="halo-byline">jinn&#8201;dev</div>
                <p dangerouslySetInnerHTML={{ __html: mdLite(SAMPLE.reply) }} />
                <div className="halo-toolline">✓ ran {SAMPLE.tools} tools · 1.8s</div>
              </div>
            </div>
          </div>
        )}

        {/* the floating island input */}
        <div className={`halo-dock ${empty ? 'is-center' : ''}`}>
          <div className="halo-island">
            <div className="halo-island-ring" />
            <button className="halo-agent-chip" title="Active agent">
              <span>{SAMPLE.agentEmoji}</span>
            </button>
            <input
              className="halo-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ask anything, or summon an agent with @"
            />
            <button className="halo-voice" title="Voice">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3v18M7 7v10M17 7v10M3 11v2M21 11v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
            <button className="halo-send" title="Send">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
          <div className="halo-hints"><b>@</b> agent · <b>/</b> command · <b>⏎</b> send</div>
        </div>
      </div>
    </div>
  )
}

/* ---------- LEDGER : operator command-line / transcript ---------- */
function Ledger({ empty }: { empty: boolean }) {
  const [text, setText] = useState(empty ? '' : 'deploy movekit funnel-alert --posthog')
  return (
    <div className="ldg-root">
      {/* status strip */}
      <div className="ldg-status">
        <span className="ldg-stat-dot" /> jinn · gateway up
        <span className="ldg-sep">│</span>
        <span className="ldg-mut">5 employees</span>
        <span className="ldg-sep">│</span>
        <span className="ldg-amber">● 2 working</span>
        <span className="ldg-grow" />
        <span className="ldg-mut">22:14 · sofia</span>
      </div>

      <div className="ldg-body">
        {/* session index */}
        <aside className="ldg-index">
          <div className="ldg-index-head">SESSIONS</div>
          {['jimbo·main', 'jinn-dev', 'movekit-support', 'pravko-lead', 'cos·audit'].map((s, i) => (
            <div key={s} className={`ldg-index-row ${i === 0 ? 'is-active' : ''}`}>
              <span className="ldg-idx-id">{String(i).padStart(2, '0')}</span>
              <span className="ldg-idx-name">{s}</span>
              {(i === 1 || i === 2) && <span className="ldg-idx-run">●</span>}
            </div>
          ))}
        </aside>

        {/* transcript */}
        <main className="ldg-stream">
          {!empty && (
            <div className="ldg-transcript">
              <div className="ldg-turn">
                <div className="ldg-spk ldg-spk-you">you&#8201;›</div>
                <div className="ldg-content">{SAMPLE.user1}</div>
              </div>
              <div className="ldg-turn">
                <div className="ldg-spk ldg-spk-agent">jinn-dev&#8201;›</div>
                <div className="ldg-content">
                  <p dangerouslySetInnerHTML={{ __html: mdLite(SAMPLE.reply) }} />
                  <div className="ldg-tool">▸ ran {SAMPLE.tools} tools<span className="ldg-tool-mut">  stripe.update · posthog.query · gh.pr · read</span></div>
                </div>
              </div>
            </div>
          )}
          {empty && (
            <div className="ldg-empty">
              <pre className="ldg-ascii">{'   ▌\n  ▌▌ jinn\n ▌▌▌ operator console\n'}</pre>
              <div className="ldg-empty-mut">type a command, or <b>/</b> to browse · <b>@</b> to route to an employee</div>
            </div>
          )}

          {/* command-line input pinned bottom */}
          <div className="ldg-prompt">
            <span className="ldg-sigil">›</span>
            <span className="ldg-cmdline">
              <span className="ldg-typed">{text}</span>
              <span className="ldg-caret" />
            </span>
            <span className="ldg-keyhints">⏎ send&nbsp;&nbsp;⌥⏎ newline&nbsp;&nbsp;/ cmd&nbsp;&nbsp;@ agent</span>
          </div>
        </main>
      </div>
    </div>
  )
}

/* ---------- MANUSCRIPT : document-as-input / letterpress ---------- */
function Manuscript({ empty }: { empty: boolean }) {
  const [text, setText] = useState(empty ? '' : 'And send a short note to MoveKit customers about the fix.')
  return (
    <div className="ms-root">
      <div className="ms-margin">
        <div className="ms-mark">J</div>
        <div className="ms-rule" />
      </div>
      <div className="ms-page">
        {empty ? (
          <div className="ms-open">
            <h1 className="ms-open-title">A new page.</h1>
            <p className="ms-open-sub">Write to Jinn the way you’d write a note.</p>
          </div>
        ) : (
          <article className="ms-doc">
            <div className="ms-entry ms-entry-you">
              <div className="ms-byline">Hristo</div>
              <p>{SAMPLE.user1}</p>
            </div>
            <div className="ms-entry ms-entry-agent">
              <div className="ms-byline">Jinn&#8201;Dev</div>
              <p dangerouslySetInnerHTML={{ __html: mdLite(SAMPLE.reply) }} />
              <div className="ms-aside">consulted 4 sources</div>
            </div>
          </article>
        )}

        {/* the document IS the input — seamless writing line */}
        <div className="ms-compose">
          <div className="ms-byline ms-byline-live">Hristo</div>
          <div className="ms-writeline">
            <span className="ms-writetext">{text}</span>
            <span className="ms-cursor" />
            {text.length === 0 && <span className="ms-ph">Continue the conversation…</span>}
          </div>
          {text.length > 0 && (
            <button className="ms-send" title="Send">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* tiny inline-markdown: `code`, **bold** */
function mdLite(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

export default function RedesignPage() {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const initial = (params.get('c') as Concept) || 'halo'
  const empty = params.get('empty') === '1'
  const [concept, setConcept] = useState<Concept>(
    CONCEPTS.some((c) => c.id === initial) ? initial : 'halo',
  )
  const hideSwitcher = params.get('bare') === '1'

  useEffect(() => {
    document.documentElement.setAttribute('data-redesign', concept)
    return () => document.documentElement.removeAttribute('data-redesign')
  }, [concept])

  const Body = useMemo(() => {
    if (concept === 'ledger') return <Ledger empty={empty} />
    if (concept === 'manuscript') return <Manuscript empty={empty} />
    return <Halo empty={empty} />
  }, [concept, empty])

  return (
    <div className="rd-shell">
      <style>{CSS}</style>
      {!hideSwitcher && (
        <div className="rd-switch">
          {CONCEPTS.map((c) => (
            <button
              key={c.id}
              className={concept === c.id ? 'is-on' : ''}
              onClick={() => setConcept(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {Body}
    </div>
  )
}

const CSS = String.raw`
.rd-shell{position:fixed;inset:0;overflow:hidden}
.rd-switch{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:50;display:flex;gap:2px;padding:3px;border-radius:999px;background:rgba(20,20,24,.6);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.12)}
.rd-switch button{font:500 12px/1 ui-sans-serif,system-ui;letter-spacing:.02em;color:rgba(255,255,255,.6);background:transparent;border:0;padding:7px 16px;border-radius:999px;cursor:pointer;transition:.18s}
.rd-switch button.is-on{background:#fff;color:#111}
code{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.86em;padding:.08em .35em;border-radius:5px;background:rgba(127,127,127,.14)}

/* ===================== HALO ===================== */
.halo-root{position:absolute;inset:0;display:flex;background:
  radial-gradient(120% 90% at 78% -10%, rgba(124,92,246,.16), transparent 55%),
  radial-gradient(90% 70% at 12% 110%, rgba(232,120,84,.12), transparent 55%),
  #141019;color:#ECE6F2;font-family:"Hanken Grotesk",system-ui,sans-serif}
.halo-rail{width:72px;display:flex;flex-direction:column;align-items:center;gap:16px;padding:22px 0;border-right:1px solid rgba(255,255,255,.06)}
.halo-mark{font-size:20px;color:#C9B6FF;opacity:.9;margin-bottom:8px}
.halo-orb{position:relative;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-size:18px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);cursor:pointer;transition:.2s}
.halo-orb:hover{transform:translateY(-1px);background:rgba(255,255,255,.09)}
.halo-orb.is-working{box-shadow:0 0 0 1px rgba(201,182,255,.5),0 0 18px rgba(160,120,255,.35)}
.halo-pulse{position:absolute;right:-1px;top:-1px;width:9px;height:9px;border-radius:50%;background:#C9B6FF;box-shadow:0 0 8px #C9B6FF;animation:haloBreathe 1.8s ease-in-out infinite}
@keyframes haloBreathe{0%,100%{opacity:.45;transform:scale(.85)}50%{opacity:1;transform:scale(1.1)}}
.halo-rail-spacer{flex:1}
.halo-orb-ghost{font-size:20px;color:rgba(255,255,255,.4);background:transparent;border-style:dashed}
.halo-stage{flex:1;position:relative;display:flex;flex-direction:column;align-items:center}
.halo-hero{margin:auto;text-align:center;padding-bottom:120px}
.halo-hero-title{font-family:"Fraunces",serif;font-size:42px;font-weight:500;letter-spacing:-.02em;background:linear-gradient(180deg,#fff,#C9B6FF);-webkit-background-clip:text;background-clip:text;color:transparent}
.halo-hero-sub{margin-top:12px;color:rgba(236,230,242,.5);font-size:15px}
.halo-thread{width:min(720px,90%);margin:0 auto;padding:64px 0 200px;flex:1;overflow:auto}
.halo-turn-user{margin:0 0 34px auto;max-width:78%}
.halo-turn-user p{display:inline-block;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);padding:13px 18px;border-radius:20px 20px 6px 20px;font-size:15.5px;line-height:1.55;float:right;clear:both}
.halo-turn-agent{display:flex;gap:16px;clear:both;margin-bottom:30px}
.halo-gutter span{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:rgba(201,182,255,.12);border:1px solid rgba(201,182,255,.25);font-size:16px}
.halo-msg{flex:1}
.halo-byline{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#C9B6FF;margin-bottom:6px;opacity:.85}
.halo-msg p{font-size:16px;line-height:1.7;color:rgba(236,230,242,.92)}
.halo-toolline{margin-top:12px;font-size:12.5px;color:rgba(236,230,242,.4)}
.halo-dock{position:absolute;left:0;right:0;bottom:30px;display:flex;flex-direction:column;align-items:center;gap:10px}
.halo-dock.is-center{bottom:auto;top:50%;transform:translateY(40px)}
.halo-island{position:relative;display:flex;align-items:center;gap:10px;width:min(680px,86%);padding:10px 12px 10px 12px;border-radius:999px;background:rgba(28,24,38,.72);backdrop-filter:blur(26px) saturate(160%);border:1px solid rgba(255,255,255,.1);box-shadow:0 20px 60px rgba(0,0,0,.5)}
.halo-island-ring{position:absolute;inset:-1px;border-radius:999px;padding:1px;background:linear-gradient(120deg,rgba(201,182,255,.7),rgba(232,120,84,.5),transparent 60%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:.8;pointer-events:none}
.halo-agent-chip{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-size:18px;background:rgba(201,182,255,.14);border:1px solid rgba(201,182,255,.3);cursor:pointer;flex:0 0 auto}
.halo-input{flex:1;background:transparent;border:0;outline:0;color:#fff;font-size:16px;font-family:inherit}
.halo-input::placeholder{color:rgba(236,230,242,.4)}
.halo-voice,.halo-send{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;cursor:pointer;flex:0 0 auto;border:0}
.halo-voice{background:transparent;color:rgba(236,230,242,.6)}
.halo-send{background:linear-gradient(150deg,#C9B6FF,#A07CFF);color:#1a1226;box-shadow:0 4px 18px rgba(160,120,255,.5)}
.halo-hints{font-size:12px;color:rgba(236,230,242,.4)}
.halo-hints b{color:rgba(236,230,242,.7);font-weight:600}

/* ===================== LEDGER ===================== */
.ldg-root{position:absolute;inset:0;display:flex;flex-direction:column;background:#14130F;color:#E8E4D8;font-family:"Hanken Grotesk",system-ui,sans-serif}
.ldg-status{display:flex;align-items:center;gap:10px;height:34px;padding:0 16px;font-family:"IBM Plex Mono",monospace;font-size:12px;color:#A8A290;border-bottom:1px solid rgba(255,255,255,.07);background:rgba(0,0,0,.2)}
.ldg-stat-dot{width:7px;height:7px;border-radius:50%;background:#7DBE6A;box-shadow:0 0 8px rgba(125,190,106,.7)}
.ldg-sep{color:rgba(255,255,255,.18)}
.ldg-mut{color:#827C6C}
.ldg-amber{color:#E0A33C}
.ldg-grow{flex:1}
.ldg-body{flex:1;display:flex;min-height:0}
.ldg-index{width:208px;border-right:1px solid rgba(255,255,255,.07);padding:14px 8px;font-family:"IBM Plex Mono",monospace}
.ldg-index-head{font-size:10.5px;letter-spacing:.18em;color:#6E6957;padding:0 8px 10px}
.ldg-index-row{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:5px;font-size:12.5px;color:#B5AF9C;cursor:pointer}
.ldg-index-row.is-active{background:rgba(224,163,60,.1);color:#F0E9D6}
.ldg-index-row:hover{background:rgba(255,255,255,.04)}
.ldg-idx-id{color:#5F5A4A}
.ldg-idx-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ldg-idx-run{color:#E0A33C;font-size:9px;animation:ldgBlink 1.4s steps(1) infinite}
@keyframes ldgBlink{50%{opacity:.25}}
.ldg-stream{flex:1;position:relative;display:flex;flex-direction:column;min-width:0}
.ldg-transcript{flex:1;overflow:auto;padding:34px 40px 120px;max-width:900px}
.ldg-turn{display:flex;gap:20px;margin-bottom:26px}
.ldg-spk{font-family:"IBM Plex Mono",monospace;font-size:13px;padding-top:2px;white-space:nowrap;flex:0 0 auto;width:96px;text-align:right}
.ldg-spk-you{color:#7FA8D6}
.ldg-spk-agent{color:#E0A33C}
.ldg-content{font-size:15.5px;line-height:1.72;color:#E2DDCF}
.ldg-content code{background:rgba(224,163,60,.14);color:#F0D89A}
.ldg-tool{margin-top:12px;font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:#8A846F;cursor:pointer}
.ldg-tool-mut{color:#5F5A4A}
.ldg-empty{flex:1;display:flex;flex-direction:column;justify-content:center;padding-left:60px}
.ldg-ascii{font-family:"IBM Plex Mono",monospace;color:#E0A33C;font-size:15px;line-height:1.35;opacity:.85}
.ldg-empty-mut{margin-top:14px;color:#827C6C;font-family:"IBM Plex Mono",monospace;font-size:12.5px}
.ldg-empty-mut b{color:#E0A33C}
.ldg-prompt{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:12px;height:54px;padding:0 24px;border-top:1px solid rgba(224,163,60,.28);background:linear-gradient(0deg,rgba(0,0,0,.35),transparent);font-family:"IBM Plex Mono",monospace}
.ldg-sigil{color:#E0A33C;font-size:18px;font-weight:600}
.ldg-cmdline{flex:1;display:flex;align-items:center;font-size:14.5px;color:#F0E9D6}
.ldg-caret{width:8px;height:17px;background:#E0A33C;margin-left:2px;animation:ldgBlink 1.1s steps(1) infinite}
.ldg-keyhints{font-size:11px;color:#6E6957;white-space:nowrap}

/* ===================== MANUSCRIPT ===================== */
.ms-root{position:absolute;inset:0;display:flex;justify-content:center;background:
  radial-gradient(140% 120% at 50% -20%, #F7F1E6, #EFE7D8 60%, #E9DFCC);
  color:#2C2317;font-family:"Newsreader","Source Serif 4",Georgia,serif}
.ms-margin{width:120px;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;padding-top:46px}
.ms-mark{font-family:"Fraunces",serif;font-size:26px;font-weight:600;color:#9B4A2F}
.ms-rule{width:1px;flex:1;margin-top:28px;background:linear-gradient(#C9B79A,transparent)}
.ms-page{width:min(720px,86%);height:100%;overflow:auto;padding:56px 0 60px;position:relative}
.ms-open{margin-top:14vh}
.ms-open-title{font-family:"Fraunces",serif;font-size:54px;font-weight:500;letter-spacing:-.02em;margin:0;color:#2C2317}
.ms-open-sub{font-size:21px;color:#6F6353;margin-top:14px;font-style:italic}
.ms-doc{}
.ms-entry{position:relative;margin-bottom:40px;padding-left:18px}
.ms-entry-agent{border-left:2px solid #D9A441}
.ms-entry-you{border-left:2px solid #C7BBA4}
.ms-byline{font-family:"Hanken Grotesk",sans-serif;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9A8C75;margin-bottom:8px}
.ms-entry-agent .ms-byline{color:#9B4A2F}
.ms-entry p{font-size:21px;line-height:1.62;color:#332A1C;margin:0}
.ms-entry-you p{color:#5A4F3E;font-style:italic}
.ms-entry code{font-family:"IBM Plex Mono",monospace;font-size:.78em;font-style:normal;background:rgba(155,74,47,.1);color:#7A3A24;padding:.1em .35em;border-radius:4px}
.ms-aside{font-family:"Hanken Grotesk",sans-serif;font-size:12px;color:#A99A82;margin-top:12px;font-style:normal}
.ms-compose{position:relative;margin-top:10px;padding-left:18px;border-left:2px solid transparent}
.ms-byline-live{color:#9A8C75}
.ms-writeline{position:relative;min-height:38px;display:flex;align-items:baseline}
.ms-writetext{font-size:21px;line-height:1.62;color:#332A1C}
.ms-cursor{display:inline-block;width:2px;height:24px;background:#9B4A2F;margin-left:1px;transform:translateY(4px);animation:msBlink 1.1s steps(1) infinite}
@keyframes msBlink{50%{opacity:0}}
.ms-ph{position:absolute;left:0;font-size:21px;color:#B6A88F;font-style:italic;pointer-events:none}
.ms-send{position:absolute;right:-46px;top:24px;width:40px;height:40px;border-radius:50%;border:1px solid #D9A441;background:#fff;color:#9B4A2F;display:grid;place-items:center;cursor:pointer;box-shadow:0 4px 14px rgba(120,80,30,.12)}
`
