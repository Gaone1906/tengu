import { useEffect, useMemo, useState } from 'react'

/* ============================================================
   GROUND-UP REDESIGN SHOWCASE — concepts, self-contained.
   /redesign?c=halo|ledger|bureau|object|ink  (&empty=1, &bare=1)
   Each concept reinvents the INPUT element + the message model.
   All share a no-bubbles "gutter transcript". Sample data only.
   ============================================================ */

type Concept = 'halo' | 'ledger' | 'bureau' | 'object' | 'ink'

const CONCEPTS: { id: Concept; label: string }[] = [
  { id: 'bureau', label: 'Bureau' },
  { id: 'object', label: 'Object' },
  { id: 'ink', label: 'Ink' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'halo', label: 'Halo' },
]

const SAMPLE = {
  user1: 'What’s the status on the MoveKit billing fix?',
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

/* tiny inline-markdown */
function mdLite(s: string) {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

/* ===================== BUREAU : light operator console ===================== */
function Bureau({ empty }: { empty: boolean }) {
  const [text] = useState(empty ? '' : 'deploy movekit funnel-alert --posthog')
  return (
    <div className="bur-root">
      <header className="bur-top">
        <span className="bur-mark">▟</span>
        <span className="bur-title">jinn</span>
        <span className="bur-dot" /> <span className="bur-mut">gateway up · 2 working</span>
        <span className="bur-grow" />
        <span className="bur-mut">22:14 · sofia</span>
      </header>

      <main className="bur-stream">
        {empty ? (
          <div className="bur-empty">
            <div className="bur-empty-h">Ready when you are.</div>
            <div className="bur-empty-s">Five employees on shift. Type a request, or <b>/</b> for commands · <b>@</b> to route to an employee.</div>
          </div>
        ) : (
          <div className="bur-transcript">
            <div className="bur-turn">
              <div className="bur-head"><i className="bur-tag bur-tag-you" />you</div>
              <p>{SAMPLE.user1}</p>
            </div>
            <div className="bur-turn">
              <div className="bur-head"><i className="bur-tag bur-tag-agent" />jinn-dev<span className="bur-time">22:13</span></div>
              <p dangerouslySetInnerHTML={{ __html: mdLite(SAMPLE.reply) }} />
              <div className="bur-tool">ran {SAMPLE.tools} tools<span className="bur-tool-mut"> · stripe.update · posthog.query · gh.pr · read</span></div>
            </div>
          </div>
        )}

        <div className="bur-bar">
          <span className="bur-sigil">›</span>
          <span className="bur-line"><span className="bur-typed">{text}</span><span className="bur-caret" />{!text && <span className="bur-ph">Message jinn…</span>}</span>
          <span className="bur-keys">⏎ send&nbsp;&nbsp;⌥⏎ newline&nbsp;&nbsp;/ cmd&nbsp;&nbsp;@ agent</span>
        </div>
      </main>
    </div>
  )
}

/* ===================== OBJECT : physical raised input tray ===================== */
function Obj({ empty }: { empty: boolean }) {
  const [text] = useState(empty ? '' : 'Draft the PostHog funnel alert')
  return (
    <div className="obj-root">
      <div className="obj-topL"><span className="obj-mark">◧</span> jinn</div>
      <div className="obj-topR">
        {SAMPLE.agents.map((a) => (
          <div key={a.id} className={`obj-chip ${a.state === 'working' ? 'is-working' : ''}`} title={a.name}>{a.emoji}</div>
        ))}
      </div>

      <div className="obj-stage">
        {empty ? (
          <div className="obj-hero">
            <div className="obj-hero-h">Good evening, Hristo.</div>
            <div className="obj-hero-s">Five on shift · two working</div>
          </div>
        ) : (
          <div className="obj-thread">
            <div className="obj-turn obj-turn-you">
              <div className="obj-tile obj-tile-you">H</div>
              <div className="obj-body"><p>{SAMPLE.user1}</p></div>
            </div>
            <div className="obj-turn">
              <div className="obj-tile">{SAMPLE.agentEmoji}</div>
              <div className="obj-body">
                <div className="obj-name">JINN-DEV</div>
                <p dangerouslySetInnerHTML={{ __html: mdLite(SAMPLE.reply) }} />
                <div className="obj-tool">▪ ran {SAMPLE.tools} tools · 1.8s</div>
              </div>
            </div>
          </div>
        )}

        <div className={`obj-dock ${empty ? 'is-center' : ''}`}>
          <div className="obj-tray">
            <button className="obj-agent">{SAMPLE.agentEmoji}</button>
            <div className="obj-input">{text || <span className="obj-ph">Message jinn, or @ an employee</span>}<span className="obj-caret" /></div>
            <button className="obj-mic" title="Voice"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3v18M7 7v10M17 7v10M3 11v2M21 11v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></button>
            <button className="obj-send" title="Send"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
          </div>
          <div className="obj-hint">⏎ send · ⌥⏎ newline · @ agent · / command</div>
        </div>
      </div>
    </div>
  )
}

/* ===================== INK : monochrome editorial, line input ===================== */
function Ink({ empty }: { empty: boolean }) {
  const [text] = useState(empty ? '' : 'And send a short note to MoveKit customers about the fix.')
  return (
    <div className="ink-root">
      <div className="ink-col">
        {empty ? (
          <div className="ink-hero">
            <h1>What needs doing?</h1>
            <p>Five employees on shift. Two are working now.</p>
          </div>
        ) : (
          <div className="ink-thread">
            <div className="ink-turn">
              <div className="ink-by">Hristo</div>
              <p className="ink-you">{SAMPLE.user1}</p>
            </div>
            <div className="ink-turn ink-turn-agent">
              <div className="ink-by">Jinn Dev</div>
              <p dangerouslySetInnerHTML={{ __html: mdLite(SAMPLE.reply) }} />
              <div className="ink-meta">— consulted {SAMPLE.tools} sources</div>
            </div>
          </div>
        )}

        {/* the input is a single line you write on */}
        <div className="ink-compose">
          <span className="ink-mono">JD</span>
          <div className="ink-writeline">
            <span className="ink-text">{text}</span><span className="ink-caret" />
            {!text && <span className="ink-ph">Write a line…</span>}
          </div>
          {!!text && <button className="ink-go" title="Send">→</button>}
        </div>
      </div>
    </div>
  )
}

/* ===================== HALO (retained) ===================== */
function Halo({ empty }: { empty: boolean }) {
  const [text] = useState(empty ? '' : 'Draft the PostHog funnel alert')
  return (
    <div className="halo-root">
      <div className="halo-rail">
        <div className="halo-mark">✶</div>
        {SAMPLE.agents.map((a) => (
          <div key={a.id} className={`halo-orb ${a.state === 'working' ? 'is-working' : ''}`} title={a.name}>
            <span>{a.emoji}</span>{a.state === 'working' && <i className="halo-pulse" />}
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
            <div className="halo-turn halo-turn-user"><p>{SAMPLE.user1}</p></div>
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
        <div className={`halo-dock ${empty ? 'is-center' : ''}`}>
          <div className="halo-island">
            <div className="halo-island-ring" />
            <button className="halo-agent-chip"><span>{SAMPLE.agentEmoji}</span></button>
            <input className="halo-input" defaultValue={text} placeholder="Ask anything, or summon an agent with @" readOnly />
            <button className="halo-voice"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3v18M7 7v10M17 7v10M3 11v2M21 11v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></button>
            <button className="halo-send"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
          </div>
          <div className="halo-hints"><b>@</b> agent · <b>/</b> command · <b>⏎</b> send</div>
        </div>
      </div>
    </div>
  )
}

/* ===================== LEDGER (retained) ===================== */
function Ledger({ empty }: { empty: boolean }) {
  const [text] = useState(empty ? '' : 'deploy movekit funnel-alert --posthog')
  return (
    <div className="ldg-root">
      <div className="ldg-status">
        <span className="ldg-stat-dot" /> jinn · gateway up
        <span className="ldg-sep">│</span><span className="ldg-mut">5 employees</span>
        <span className="ldg-sep">│</span><span className="ldg-amber">● 2 working</span>
        <span className="ldg-grow" /><span className="ldg-mut">22:14 · sofia</span>
      </div>
      <div className="ldg-body">
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
        <main className="ldg-stream">
          {!empty && (
            <div className="ldg-transcript">
              <div className="ldg-turn"><div className="ldg-spk ldg-spk-you">you&#8201;›</div><div className="ldg-content">{SAMPLE.user1}</div></div>
              <div className="ldg-turn"><div className="ldg-spk ldg-spk-agent">jinn-dev&#8201;›</div>
                <div className="ldg-content"><p dangerouslySetInnerHTML={{ __html: mdLite(SAMPLE.reply) }} />
                  <div className="ldg-tool">▸ ran {SAMPLE.tools} tools<span className="ldg-tool-mut">  stripe.update · posthog.query · gh.pr · read</span></div>
                </div>
              </div>
            </div>
          )}
          {empty && (
            <div className="ldg-empty"><pre className="ldg-ascii">{'   ▌\n  ▌▌ jinn\n ▌▌▌ operator console\n'}</pre>
              <div className="ldg-empty-mut">type a command, or <b>/</b> to browse · <b>@</b> to route to an employee</div></div>
          )}
          <div className="ldg-prompt">
            <span className="ldg-sigil">›</span>
            <span className="ldg-cmdline"><span className="ldg-typed">{text}</span><span className="ldg-caret" /></span>
            <span className="ldg-keyhints">⏎ send&nbsp;&nbsp;⌥⏎ newline&nbsp;&nbsp;/ cmd&nbsp;&nbsp;@ agent</span>
          </div>
        </main>
      </div>
    </div>
  )
}

export default function RedesignPage() {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const initial = (params.get('c') as Concept) || 'bureau'
  const empty = params.get('empty') === '1'
  const hideSwitcher = params.get('bare') === '1'
  const [concept, setConcept] = useState<Concept>(
    CONCEPTS.some((c) => c.id === initial) ? initial : 'bureau',
  )

  useEffect(() => {
    document.documentElement.setAttribute('data-redesign', concept)
    return () => document.documentElement.removeAttribute('data-redesign')
  }, [concept])

  const Body = useMemo(() => {
    switch (concept) {
      case 'ledger': return <Ledger empty={empty} />
      case 'halo': return <Halo empty={empty} />
      case 'object': return <Obj empty={empty} />
      case 'ink': return <Ink empty={empty} />
      default: return <Bureau empty={empty} />
    }
  }, [concept, empty])

  return (
    <div className="rd-shell">
      <style>{CSS}</style>
      {!hideSwitcher && (
        <div className="rd-switch">
          {CONCEPTS.map((c) => (
            <button key={c.id} className={concept === c.id ? 'is-on' : ''} onClick={() => setConcept(c.id)}>{c.label}</button>
          ))}
        </div>
      )}
      {Body}
    </div>
  )
}

const CSS = String.raw`
.rd-shell{position:fixed;inset:0;overflow:hidden}
.rd-switch{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:50;display:flex;gap:2px;padding:3px;border-radius:999px;background:rgba(20,20,24,.55);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.12)}
.rd-switch button{font:500 12px/1 ui-sans-serif,system-ui;letter-spacing:.02em;color:rgba(255,255,255,.62);background:transparent;border:0;padding:7px 16px;border-radius:999px;cursor:pointer;transition:.18s}
.rd-switch button.is-on{background:#fff;color:#111}
code{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.85em;padding:.08em .35em;border-radius:5px;background:rgba(127,127,127,.14)}

/* ============ BUREAU ============ */
.bur-root{position:absolute;inset:0;display:flex;flex-direction:column;background:#F2EDE2;color:#23201A;font-family:"Hanken Grotesk",system-ui,sans-serif}
.bur-top{display:flex;align-items:center;gap:8px;height:46px;padding:0 22px;border-bottom:1px solid #DED7C7;font-size:13px}
.bur-mark{color:#8A3A33;font-size:14px}
.bur-title{font-weight:600;letter-spacing:.01em}
.bur-dot{width:7px;height:7px;border-radius:50%;background:#5C7A4A;margin-left:6px}
.bur-mut{color:#9A917F;font-family:"IBM Plex Mono",monospace;font-size:12px}
.bur-grow{flex:1}
.bur-stream{flex:1;position:relative;display:flex;flex-direction:column;min-height:0}
.bur-transcript{flex:1;overflow:auto;width:min(760px,92%);margin:0 auto;padding:40px 0 120px}
.bur-turn{margin-bottom:30px}
.bur-head{display:flex;align-items:center;gap:8px;font-family:"IBM Plex Mono",monospace;font-size:12px;letter-spacing:.04em;color:#6B6457;text-transform:lowercase;margin-bottom:8px}
.bur-tag{width:7px;height:7px;border-radius:2px;display:inline-block}
.bur-tag-you{background:#3E5C86}
.bur-tag-agent{background:#8A3A33}
.bur-time{color:#B7AE9C;margin-left:auto}
.bur-turn p{font-size:16px;line-height:1.7;color:#2C271E}
.bur-tool{margin-top:12px;font-family:"IBM Plex Mono",monospace;font-size:12px;color:#9A917F}
.bur-tool-mut{color:#BBB2A0}
.bur-empty{margin:auto;width:min(680px,90%);text-align:center;padding-bottom:90px}
.bur-empty-h{font-size:30px;font-weight:500;letter-spacing:-.01em}
.bur-empty-s{margin-top:12px;color:#6B6457;font-size:15px;line-height:1.6}
.bur-empty-s b{color:#8A3A33;font-family:"IBM Plex Mono",monospace}
.bur-bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:12px;height:56px;padding:0 24px;border-top:1px solid #D9C9A8;background:#F7F2E8;font-family:"IBM Plex Mono",monospace}
.bur-sigil{color:#8A3A33;font-size:17px;font-weight:600}
.bur-line{flex:1;display:flex;align-items:center;position:relative;font-size:14.5px;color:#2C271E}
.bur-caret{width:8px;height:17px;background:#8A3A33;margin-left:1px;animation:burBlink 1.1s steps(1) infinite}
.bur-ph{position:absolute;left:0;color:#B0A793}
@keyframes burBlink{50%{opacity:0}}
.bur-keys{font-size:11px;color:#A99F8B;white-space:nowrap}

/* ============ OBJECT ============ */
.obj-root{position:absolute;inset:0;background:radial-gradient(130% 100% at 50% 0%, #EEEBE4, #E5E2DA);color:#1C1B18;font-family:"Geist",system-ui,sans-serif}
.obj-topL{position:absolute;top:20px;left:24px;display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;letter-spacing:.02em;color:#3A3833}
.obj-mark{color:#CF4D24}
.obj-topR{position:absolute;top:16px;right:20px;display:flex;gap:8px}
.obj-chip{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;font-size:16px;background:#FBFAF6;border:1px solid #D2CFC6;box-shadow:0 1px 2px rgba(30,28,24,.06);position:relative}
.obj-chip.is-working::after{content:"";position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:50%;background:#CF4D24;border:2px solid #ECEAE4}
.obj-stage{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center}
.obj-hero{margin:auto;text-align:center;padding-bottom:120px}
.obj-hero-h{font-size:34px;font-weight:540;letter-spacing:-.02em}
.obj-hero-s{margin-top:10px;color:#6A685F;font-size:14px;font-family:"Geist Mono",monospace}
.obj-thread{width:min(700px,90%);margin:0 auto;padding:74px 0 200px;flex:1;overflow:auto}
.obj-turn{display:flex;gap:16px;margin-bottom:26px}
.obj-tile{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;font-size:16px;background:#FBFAF6;border:1px solid #D2CFC6;flex:0 0 auto}
.obj-tile-you{background:#1C1B18;color:#F4F2EC;font-weight:600;font-size:14px}
.obj-body{flex:1}
.obj-turn-you .obj-body p{color:#4A483F}
.obj-name{font-family:"Geist Mono",monospace;font-size:11px;letter-spacing:.08em;color:#CF4D24;margin-bottom:6px}
.obj-body p{font-size:15.5px;line-height:1.66;color:#26251F}
.obj-tool{margin-top:12px;font-family:"Geist Mono",monospace;font-size:11.5px;color:#94908544;color:#A29E92}
.obj-dock{position:absolute;left:0;right:0;bottom:34px;display:flex;flex-direction:column;align-items:center;gap:9px}
.obj-dock.is-center{bottom:auto;top:50%;transform:translateY(46px)}
.obj-tray{display:flex;align-items:center;gap:8px;width:min(640px,86%);padding:9px 9px 9px 9px;border-radius:14px;background:#FBFAF6;border:1px solid #D2CFC6;box-shadow:0 1px 0 rgba(255,255,255,.7) inset,0 8px 28px rgba(40,36,28,.12),0 1px 3px rgba(40,36,28,.08)}
.obj-agent{width:38px;height:38px;border-radius:9px;display:grid;place-items:center;font-size:17px;background:#F1EEE6;border:1px solid #DBD7CD;cursor:pointer;flex:0 0 auto}
.obj-input{flex:1;display:flex;align-items:center;font-size:15.5px;color:#26251F;position:relative}
.obj-ph{color:#A8A498}
.obj-caret{width:2px;height:18px;background:#1C1B18;margin-left:1px;animation:burBlink 1.1s steps(1) infinite}
.obj-mic{width:38px;height:38px;border-radius:9px;display:grid;place-items:center;background:transparent;border:0;color:#807C70;cursor:pointer;flex:0 0 auto}
.obj-send{width:38px;height:38px;border-radius:9px;display:grid;place-items:center;background:#CF4D24;color:#fff;border:0;cursor:pointer;flex:0 0 auto;box-shadow:0 2px 8px rgba(207,77,36,.3)}
.obj-hint{font-family:"Geist Mono",monospace;font-size:11px;color:#9A968A}

/* ============ INK ============ */
.ink-root{position:absolute;inset:0;background:#F4F1EA;color:#1A1714;font-family:"Source Serif 4",Georgia,serif;display:flex;justify-content:center}
.ink-col{width:min(660px,88%);height:100%;display:flex;flex-direction:column;padding:0 0 44px}
.ink-hero{margin-top:20vh}
.ink-hero h1{font-family:"Fraunces",serif;font-size:50px;font-weight:430;letter-spacing:-.02em;margin:0;color:#1A1714}
.ink-hero p{font-size:19px;color:#6E665B;margin-top:14px;font-style:italic}
.ink-thread{flex:1;overflow:auto;padding:56px 0 40px}
.ink-turn{margin-bottom:34px}
.ink-turn-agent{padding-left:20px;border-left:1px solid #D7CFC0}
.ink-by{font-family:"Fraunces",serif;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#9A8F7E;margin-bottom:9px}
.ink-turn p{font-size:20px;line-height:1.62;color:#241F19;margin:0}
.ink-you{color:#5A5145;font-style:italic}
.ink-turn code{font-family:"IBM Plex Mono",monospace;font-size:.74em;font-style:normal;background:#E7E0D2;color:#3A332A;padding:.1em .35em;border-radius:4px}
.ink-meta{margin-top:12px;font-family:"Fraunces",serif;font-size:13px;font-style:italic;color:#A89D8B}
.ink-compose{margin-top:auto;display:flex;align-items:center;gap:16px;padding-top:18px;border-top:1px solid #1A1714}
.ink-mono{font-family:"Fraunces",serif;font-size:13px;letter-spacing:.1em;color:#1A1714;border:1px solid #1A1714;border-radius:50%;width:30px;height:30px;display:grid;place-items:center;flex:0 0 auto}
.ink-writeline{flex:1;position:relative;display:flex;align-items:center;min-height:34px}
.ink-text{font-size:20px;color:#241F19}
.ink-caret{width:2px;height:24px;background:#1A1714;margin-left:1px;animation:burBlink 1.05s steps(1) infinite}
.ink-ph{position:absolute;left:0;font-size:20px;color:#B3A892;font-style:italic}
.ink-go{width:36px;height:36px;border-radius:50%;border:1px solid #1A1714;background:transparent;color:#1A1714;font-size:18px;cursor:pointer;flex:0 0 auto}

/* ============ HALO (retained, unchanged) ============ */
.halo-root{position:absolute;inset:0;display:flex;background:radial-gradient(120% 90% at 78% -10%, rgba(124,92,246,.16), transparent 55%),radial-gradient(90% 70% at 12% 110%, rgba(232,120,84,.12), transparent 55%),#141019;color:#ECE6F2;font-family:"Hanken Grotesk",system-ui,sans-serif}
.halo-rail{width:72px;display:flex;flex-direction:column;align-items:center;gap:16px;padding:22px 0;border-right:1px solid rgba(255,255,255,.06)}
.halo-mark{font-size:20px;color:#C9B6FF;opacity:.9;margin-bottom:8px}
.halo-orb{position:relative;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-size:18px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09)}
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
.halo-island{position:relative;display:flex;align-items:center;gap:10px;width:min(680px,86%);padding:10px 12px;border-radius:999px;background:rgba(28,24,38,.72);backdrop-filter:blur(26px) saturate(160%);border:1px solid rgba(255,255,255,.1);box-shadow:0 20px 60px rgba(0,0,0,.5)}
.halo-island-ring{position:absolute;inset:-1px;border-radius:999px;padding:1px;background:linear-gradient(120deg,rgba(201,182,255,.7),rgba(232,120,84,.5),transparent 60%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:.8;pointer-events:none}
.halo-agent-chip{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-size:18px;background:rgba(201,182,255,.14);border:1px solid rgba(201,182,255,.3);cursor:pointer;flex:0 0 auto}
.halo-input{flex:1;background:transparent;border:0;outline:0;color:#fff;font-size:16px;font-family:inherit}
.halo-input::placeholder{color:rgba(236,230,242,.4)}
.halo-voice,.halo-send{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;cursor:pointer;flex:0 0 auto;border:0}
.halo-voice{background:transparent;color:rgba(236,230,242,.6)}
.halo-send{background:linear-gradient(150deg,#C9B6FF,#A07CFF);color:#1a1226;box-shadow:0 4px 18px rgba(160,120,255,.5)}
.halo-hints{font-size:12px;color:rgba(236,230,242,.4)}
.halo-hints b{color:rgba(236,230,242,.7);font-weight:600}

/* ============ LEDGER (retained, unchanged) ============ */
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
`
