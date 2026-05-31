import { useEffect, useMemo, useState } from 'react'

/* ============================================================
   OBJECT family — same visual language, three navigation models.
   /redesign?c=object|dock|split|stage  (&empty=1, &bare=1)
   Warm-grey industrial · physical raised tray · signal-orange · square tiles.
   Focus axes: dock=switch · split=multitask · stage=focus.
   ============================================================ */

type Concept = 'object' | 'dock' | 'split' | 'stage'

const CONCEPTS: { id: Concept; label: string }[] = [
  { id: 'object', label: 'Object' },
  { id: 'dock', label: 'Dock' },
  { id: 'split', label: 'Split' },
  { id: 'stage', label: 'Stage' },
]

const EMOJI = {
  jimbo: '\u{1F3A9}', dev: '\u{1F9D1}‍\u{1F4BB}', pravko: '⚖️', movekit: '\u{1F4E6}', cos: '\u{1F4CB}', reddit: '\u{1F47D}',
}

const SAMPLE = {
  user1: 'What’s the status on the MoveKit billing fix?',
  reply:
    'The AVS / billing-address fix shipped to all MoveKit Checkout Sessions — `billing_address_collection: "required"`. Conversion held flat through the first 48 hours, so no regression. I’ve queued the 30-day review for June 17. Want me to wire a PostHog funnel alert in the meantime?',
  tools: 4,
}

const EMPLOYEES = [
  { id: 'jimbo', emoji: EMOJI.jimbo, name: 'Jimbo', state: 'idle', unread: 0 },
  { id: 'jinn-dev', emoji: EMOJI.dev, name: 'Jinn Dev', state: 'working', unread: 0 },
  { id: 'movekit', emoji: EMOJI.movekit, name: 'MoveKit Support', state: 'working', unread: 2 },
  { id: 'pravko', emoji: EMOJI.pravko, name: 'Pravko Lead', state: 'idle', unread: 0 },
  { id: 'cos', emoji: EMOJI.cos, name: 'Chief of Staff', state: 'idle', unread: 1 },
  { id: 'reddit', emoji: EMOJI.reddit, name: 'Reddit Scout', state: 'idle', unread: 0 },
]

const THREADS = [
  { agent: 'jinn-dev', emoji: EMOJI.dev, name: 'Jinn Dev', title: 'MoveKit billing fix', snippet: 'queued the 30-day review for June 17…', state: 'working', unread: 0 },
  { agent: 'movekit', emoji: EMOJI.movekit, name: 'MoveKit Support', title: 'Refund — Pedro M.', snippet: 'drafted reply, awaiting your ✅', state: 'working', unread: 2 },
  { agent: 'pravko', emoji: EMOJI.pravko, name: 'Pravko Lead', title: 'ВКС tax brief', snippet: '2 case sources verified', state: 'idle', unread: 0 },
  { agent: 'cos', emoji: EMOJI.cos, name: 'Chief of Staff', title: 'Weekly audit', snippet: '3 findings to review', state: 'idle', unread: 1 },
]

const DEV_CHATS = [
  { title: 'MoveKit billing fix', snippet: 'queued the 30-day review…', state: 'working' },
  { title: 'Gateway WS reconnect', snippet: 'patched the boot-guard', state: 'idle' },
  { title: 'Redesign showcase', snippet: 'three concepts shipped', state: 'idle' },
]

function mdLite(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

/* reusable Object-style turns */
function Turns() {
  return (
    <>
      <div className="ob-turn ob-turn-you">
        <div className="ob-tile ob-tile-you">H</div>
        <div className="ob-body"><p>{SAMPLE.user1}</p></div>
      </div>
      <div className="ob-turn">
        <div className="ob-tile">{EMOJI.dev}</div>
        <div className="ob-body">
          <div className="ob-name">JINN-DEV</div>
          <p dangerouslySetInnerHTML={{ __html: mdLite(SAMPLE.reply) }} />
          <div className="ob-tool">▪ ran {SAMPLE.tools} tools · 1.8s</div>
        </div>
      </div>
    </>
  )
}

function Tray({ value, mini }: { value: string; mini?: boolean }) {
  return (
    <div className={`ob-tray ${mini ? 'is-mini' : ''}`}>
      <button className="ob-agent">{EMOJI.dev}</button>
      <div className="ob-input">{value || <span className="ob-ph">Message jinn, or @ an employee</span>}<span className="ob-caret" /></div>
      {!mini && <button className="ob-mic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3v18M7 7v10M17 7v10M3 11v2M21 11v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></button>}
      <button className="ob-send"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
    </div>
  )
}

/* ===================== OBJECT (base, retained) ===================== */
function Obj({ empty }: { empty: boolean }) {
  return (
    <div className="ob-root">
      <div className="ob-topL"><span className="ob-mark">◧</span> jinn</div>
      <div className="ob-topR">{EMPLOYEES.slice(0, 5).map((a) => (
        <div key={a.id} className={`ob-chip ${a.state === 'working' ? 'is-working' : ''}`} title={a.name}>{a.emoji}</div>
      ))}</div>
      <div className="ob-stage">
        {empty ? (
          <div className="ob-hero"><div className="ob-hero-h">Good evening, Hristo.</div><div className="ob-hero-s">Five on shift · two working</div></div>
        ) : (
          <div className="ob-thread"><Turns /></div>
        )}
        <div className={`ob-dock ${empty ? 'is-center' : ''}`}>
          <Tray value={empty ? '' : 'Draft the PostHog funnel alert'} />
          <div className="ob-hint">⏎ send · ⌥⏎ newline · @ agent · / command</div>
        </div>
      </div>
    </div>
  )
}

/* ===================== DOCK : switching-first ===================== */
function Dock({ empty }: { empty: boolean }) {
  return (
    <div className="ob-root dk-root">
      {/* employee rail */}
      <aside className="dk-rail">
        <div className="dk-mark">◧</div>
        {EMPLOYEES.map((a, i) => (
          <button key={a.id} className={`dk-tile ${i === 1 ? 'is-active' : ''} ${a.state === 'working' ? 'is-working' : ''}`} title={a.name}>
            {a.emoji}
            {a.unread > 0 && <span className="dk-badge">{a.unread}</span>}
          </button>
        ))}
        <div className="dk-grow" />
        <button className="dk-tile dk-add">+</button>
      </aside>

      {/* chats of selected employee */}
      <aside className="dk-chats">
        <div className="dk-chats-head"><span className="dk-emp">{EMOJI.dev} Jinn Dev</span><span className="dk-emp-state">working</span></div>
        <button className="dk-search">Search agents & chats <kbd>⌘K</kbd></button>
        {DEV_CHATS.map((c, i) => (
          <div key={c.title} className={`dk-chat ${i === 0 ? 'is-active' : ''}`}>
            <div className="dk-chat-t">{c.title}{c.state === 'working' && <span className="dk-run" />}</div>
            <div className="dk-chat-s">{c.snippet}</div>
          </div>
        ))}
      </aside>

      {/* focused conversation */}
      <main className="dk-main">
        <div className="ob-thread dk-thread"><Turns /></div>
        <div className="ob-dock"><Tray value="Draft the PostHog funnel alert" /><div className="ob-hint">⌘1–9 jump to agent · ⌘K switch · @ route</div></div>
      </main>

      {/* ⌘K switcher overlay (shown on empty) */}
      {empty && (
        <div className="dk-overlay">
          <div className="dk-palette">
            <div className="dk-pal-input"><span className="dk-pal-q">move</span><span className="ob-caret" /></div>
            <div className="dk-pal-group">EMPLOYEES</div>
            <div className="dk-pal-row is-sel">{EMOJI.movekit} <b>MoveKit Support</b><span className="dk-pal-mut">2 unread · working</span><kbd>↵</kbd></div>
            <div className="dk-pal-group">CHATS</div>
            <div className="dk-pal-row">{EMOJI.dev} MoveKit billing fix <span className="dk-pal-mut">Jinn Dev · working</span></div>
            <div className="dk-pal-row">{EMOJI.movekit} Refund — Pedro M. <span className="dk-pal-mut">MoveKit · awaiting ✅</span></div>
            <div className="dk-pal-foot"><span>↑↓ navigate</span><span>↵ open</span><span>⌘↵ open in split</span><span>esc</span></div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ===================== SPLIT : multitask-first ===================== */
function Split({ empty }: { empty: boolean }) {
  const panes = empty
    ? [
        { id: 'jinn-dev', emoji: EMOJI.dev, name: 'Jinn Dev', state: 'working', active: true },
        { id: 'movekit', emoji: EMOJI.movekit, name: 'MoveKit Support', state: 'working', active: false },
        { id: 'pravko', emoji: EMOJI.pravko, name: 'Pravko Lead', state: 'idle', active: false },
      ]
    : [
        { id: 'jinn-dev', emoji: EMOJI.dev, name: 'Jinn Dev', state: 'working', active: true },
        { id: 'movekit', emoji: EMOJI.movekit, name: 'MoveKit Support', state: 'working', active: false },
      ]
  return (
    <div className="ob-root sp-root">
      <div className="sp-tabs">
        <span className="sp-mark">◧ jinn</span>
        {[...panes, { id: 'add' } as any].map((p) =>
          p.id === 'add' ? (
            <button key="add" className="sp-tab sp-tab-add">+ pane</button>
          ) : (
            <button key={p.id} className={`sp-tab ${p.active ? 'is-active' : ''}`}>
              <span className="sp-tab-e">{p.emoji}</span>{p.name}{p.state === 'working' && <span className="sp-run" />}
            </button>
          ),
        )}
        <span className="ob-grow" />
        <span className="sp-mut">2 working · 22:14</span>
      </div>
      <div className={`sp-cols cols-${panes.length}`}>
        {panes.map((p) => (
          <section key={p.id} className={`sp-pane ${p.active ? 'is-active' : 'is-dim'}`}>
            <header className="sp-pane-head">
              <span className="sp-pane-e">{p.emoji}</span>
              <span className="sp-pane-n">{p.name}</span>
              <span className={`sp-pane-st ${p.state === 'working' ? 'is-working' : ''}`}>{p.state === 'working' ? 'working…' : 'idle'}</span>
            </header>
            <div className="sp-stream">
              <div className="ob-turn ob-turn-you"><div className="ob-tile ob-tile-you">H</div><div className="ob-body"><p>{p.id === 'movekit' ? 'Did Pedro reply yet?' : SAMPLE.user1}</p></div></div>
              <div className="ob-turn"><div className="ob-tile">{p.emoji}</div><div className="ob-body"><div className="ob-name">{p.name.toUpperCase()}</div>
                <p dangerouslySetInnerHTML={{ __html: mdLite(p.id === 'movekit' ? 'Pedro replied — accepted the $49 image add-on. I drafted the confirmation; it’s waiting for your ✅ in #movekit-support.' : SAMPLE.reply) }} />
              </div></div>
            </div>
            <div className="sp-tray"><Tray value={p.active ? 'Draft the PostHog funnel alert' : ''} mini /></div>
          </section>
        ))}
      </div>
    </div>
  )
}

/* ===================== STAGE : focus-first + thread dock ===================== */
function Stage({ empty }: { empty: boolean }) {
  return (
    <div className="ob-root st-root">
      <div className="st-top"><span className="ob-mark">◧</span> jinn<span className="st-top-mut">· four threads live</span><span className="ob-grow" /><span className="st-top-mut">⌘K</span></div>

      <div className="st-stage">
        {empty ? (
          <div className="ob-hero"><div className="ob-hero-h">Good evening, Hristo.</div><div className="ob-hero-s">Four threads running in the wings — pick one up, or start fresh.</div></div>
        ) : (
          <div className="ob-thread st-thread"><Turns /></div>
        )}
        <div className="st-trayWrap"><Tray value={empty ? '' : 'Draft the PostHog funnel alert'} /></div>
      </div>

      {/* live thread dock — glanceable multitask, click to bring to stage */}
      <div className="st-dock">
        {THREADS.map((t, i) => (
          <div key={t.title} className={`st-card ${i === 0 ? 'is-onstage' : ''} ${t.state === 'working' ? 'is-working' : ''}`}>
            <div className="st-card-top">
              <span className="st-card-e">{t.emoji}</span>
              <span className="st-card-n">{t.name}</span>
              {t.state === 'working' ? <span className="st-card-live" /> : t.unread > 0 ? <span className="st-card-badge">{t.unread}</span> : null}
            </div>
            <div className="st-card-title">{t.title}</div>
            <div className="st-card-snip">{t.snippet}</div>
          </div>
        ))}
        <div className="st-card st-card-add">＋<span>new thread</span></div>
      </div>
    </div>
  )
}

export default function RedesignPage() {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const initial = (params.get('c') as Concept) || 'dock'
  const empty = params.get('empty') === '1'
  const hideSwitcher = params.get('bare') === '1'
  const [concept, setConcept] = useState<Concept>(CONCEPTS.some((c) => c.id === initial) ? initial : 'dock')

  useEffect(() => {
    document.documentElement.setAttribute('data-redesign', concept)
    return () => document.documentElement.removeAttribute('data-redesign')
  }, [concept])

  const Body = useMemo(() => {
    switch (concept) {
      case 'dock': return <Dock empty={empty} />
      case 'split': return <Split empty={empty} />
      case 'stage': return <Stage empty={empty} />
      default: return <Obj empty={empty} />
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
.rd-switch{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:80;display:flex;gap:2px;padding:3px;border-radius:999px;background:rgba(20,20,24,.55);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.12)}
.rd-switch button{font:500 12px/1 ui-sans-serif,system-ui;letter-spacing:.02em;color:rgba(255,255,255,.62);background:transparent;border:0;padding:7px 16px;border-radius:999px;cursor:pointer;transition:.18s}
.rd-switch button.is-on{background:#fff;color:#111}
code{font-family:"Geist Mono","IBM Plex Mono",ui-monospace,monospace;font-size:.82em;padding:.08em .35em;border-radius:5px;background:rgba(120,116,104,.16)}

/* ---- shared OBJECT language ---- */
.ob-root{position:absolute;inset:0;background:radial-gradient(130% 100% at 50% 0%, #EEEBE4, #E5E2DA);color:#1C1B18;font-family:"Geist",system-ui,sans-serif}
.ob-grow{flex:1}
.ob-mark{color:#CF4D24}
.ob-topL{position:absolute;top:20px;left:24px;display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;letter-spacing:.02em;color:#3A3833;z-index:2}
.ob-topR{position:absolute;top:16px;right:20px;display:flex;gap:8px;z-index:2}
.ob-chip{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;font-size:16px;background:#FBFAF6;border:1px solid #D2CFC6;box-shadow:0 1px 2px rgba(30,28,24,.06);position:relative}
.ob-chip.is-working::after{content:"";position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:50%;background:#CF4D24;border:2px solid #ECEAE4}
.ob-stage{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center}
.ob-hero{margin:auto;text-align:center;padding-bottom:120px}
.ob-hero-h{font-size:34px;font-weight:540;letter-spacing:-.02em}
.ob-hero-s{margin-top:10px;color:#6A685F;font-size:14px;font-family:"Geist Mono",monospace}
.ob-thread{width:min(700px,90%);margin:0 auto;padding:74px 0 200px;flex:1;overflow:auto}
.ob-turn{display:flex;gap:16px;margin-bottom:26px}
.ob-tile{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;font-size:16px;background:#FBFAF6;border:1px solid #D2CFC6;flex:0 0 auto}
.ob-tile-you{background:#1C1B18;color:#F4F2EC;font-weight:600;font-size:14px}
.ob-body{flex:1}
.ob-turn-you .ob-body p{color:#4A483F}
.ob-name{font-family:"Geist Mono",monospace;font-size:11px;letter-spacing:.08em;color:#CF4D24;margin-bottom:6px}
.ob-body p{font-size:15.5px;line-height:1.66;color:#26251F}
.ob-tool{margin-top:12px;font-family:"Geist Mono",monospace;font-size:11.5px;color:#A29E92}
.ob-dock{position:absolute;left:0;right:0;bottom:34px;display:flex;flex-direction:column;align-items:center;gap:9px}
.ob-dock.is-center{bottom:auto;top:50%;transform:translateY(46px)}
.ob-tray{display:flex;align-items:center;gap:8px;width:min(640px,86%);padding:9px;border-radius:14px;background:#FBFAF6;border:1px solid #D2CFC6;box-shadow:0 1px 0 rgba(255,255,255,.7) inset,0 8px 28px rgba(40,36,28,.12),0 1px 3px rgba(40,36,28,.08)}
.ob-tray.is-mini{padding:7px;border-radius:11px;box-shadow:0 1px 0 rgba(255,255,255,.7) inset,0 4px 14px rgba(40,36,28,.1)}
.ob-agent{width:38px;height:38px;border-radius:9px;display:grid;place-items:center;font-size:17px;background:#F1EEE6;border:1px solid #DBD7CD;cursor:pointer;flex:0 0 auto}
.ob-tray.is-mini .ob-agent{width:30px;height:30px;font-size:14px;border-radius:7px}
.ob-input{flex:1;display:flex;align-items:center;font-size:15.5px;color:#26251F;position:relative}
.ob-tray.is-mini .ob-input{font-size:13.5px}
.ob-ph{color:#A8A498}
.ob-caret{width:2px;height:18px;background:#1C1B18;margin-left:1px;animation:obBlink 1.1s steps(1) infinite}
@keyframes obBlink{50%{opacity:0}}
.ob-mic{width:38px;height:38px;border-radius:9px;display:grid;place-items:center;background:transparent;border:0;color:#807C70;cursor:pointer;flex:0 0 auto}
.ob-send{width:38px;height:38px;border-radius:9px;display:grid;place-items:center;background:#CF4D24;color:#fff;border:0;cursor:pointer;flex:0 0 auto;box-shadow:0 2px 8px rgba(207,77,36,.3)}
.ob-tray.is-mini .ob-send{width:30px;height:30px;border-radius:7px}
.ob-hint{font-family:"Geist Mono",monospace;font-size:11px;color:#9A968A}

/* ---- DOCK ---- */
.dk-root{display:flex}
.dk-rail{width:64px;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 0;border-right:1px solid #D8D4CB;background:rgba(250,247,239,.5)}
.dk-mark{color:#CF4D24;font-size:18px;margin-bottom:6px}
.dk-tile{position:relative;width:40px;height:40px;border-radius:10px;display:grid;place-items:center;font-size:18px;background:#FBFAF6;border:1px solid #D2CFC6;cursor:pointer;transition:.16s}
.dk-tile:hover{transform:translateY(-1px)}
.dk-tile.is-active{border-color:#1C1B18;box-shadow:0 0 0 1.5px #1C1B18}
.dk-tile.is-working::after{content:"";position:absolute;top:-2px;right:-2px;width:9px;height:9px;border-radius:50%;background:#CF4D24;border:2px solid #EFECE4}
.dk-badge{position:absolute;bottom:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#1C1B18;color:#fff;font-size:10px;font-weight:600;display:grid;place-items:center}
.dk-grow{flex:1}
.dk-add{font-size:20px;color:#8A8678;border-style:dashed;background:transparent}
.dk-chats{width:248px;flex:0 0 auto;border-right:1px solid #D8D4CB;padding:16px 12px;display:flex;flex-direction:column;gap:6px}
.dk-chats-head{display:flex;align-items:baseline;justify-content:space-between;padding:2px 6px 6px}
.dk-emp{font-size:14px;font-weight:600}
.dk-emp-state{font-family:"Geist Mono",monospace;font-size:11px;color:#CF4D24}
.dk-search{display:flex;align-items:center;justify-content:space-between;width:100%;padding:9px 12px;border-radius:10px;background:#F1EEE6;border:1px solid #DBD7CD;color:#8A8678;font:inherit;font-size:13px;cursor:pointer;margin-bottom:6px}
.dk-search kbd{font-family:"Geist Mono",monospace;font-size:11px;background:#E4E0D6;border:1px solid #D2CFC6;border-radius:5px;padding:1px 5px;color:#6A685F}
.dk-chat{padding:10px 12px;border-radius:10px;cursor:pointer}
.dk-chat:hover{background:#F1EEE6}
.dk-chat.is-active{background:#FBFAF6;border:1px solid #D2CFC6;box-shadow:0 1px 2px rgba(30,28,24,.05)}
.dk-chat-t{font-size:13.5px;font-weight:550;display:flex;align-items:center;gap:7px}
.dk-run{width:7px;height:7px;border-radius:50%;background:#CF4D24}
.dk-chat-s{font-size:12px;color:#8A8678;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-main{flex:1;position:relative;min-width:0}
.dk-thread{padding-top:40px}
.dk-overlay{position:absolute;inset:0;background:rgba(30,28,24,.28);backdrop-filter:blur(2px);display:flex;justify-content:center;padding-top:13vh;z-index:20}
.dk-palette{width:min(560px,90%);height:max-content;background:#FBFAF6;border:1px solid #CFCBC1;border-radius:16px;box-shadow:0 30px 80px rgba(30,28,24,.3);overflow:hidden}
.dk-pal-input{display:flex;align-items:center;padding:18px 20px;font-size:18px;border-bottom:1px solid #E4E0D6}
.dk-pal-q{color:#1C1B18}
.dk-pal-group{font-family:"Geist Mono",monospace;font-size:10.5px;letter-spacing:.12em;color:#A29E92;padding:12px 20px 4px}
.dk-pal-row{display:flex;align-items:center;gap:10px;padding:9px 20px;font-size:14px;cursor:pointer}
.dk-pal-row b{font-weight:600}
.dk-pal-row .dk-pal-mut{margin-left:auto;font-family:"Geist Mono",monospace;font-size:11px;color:#9A968A}
.dk-pal-row kbd{font-family:"Geist Mono",monospace;font-size:11px;background:#E4E0D6;border-radius:4px;padding:1px 5px;margin-left:10px}
.dk-pal-row.is-sel{background:#F1EEE6;box-shadow:inset 2px 0 0 #CF4D24}
.dk-pal-foot{display:flex;gap:16px;padding:11px 20px;border-top:1px solid #E4E0D6;font-family:"Geist Mono",monospace;font-size:11px;color:#9A968A}

/* ---- SPLIT ---- */
.sp-root{display:flex;flex-direction:column}
.sp-tabs{display:flex;align-items:center;gap:6px;height:46px;padding:0 14px;border-bottom:1px solid #D8D4CB;background:rgba(250,247,239,.5)}
.sp-mark{font-size:13px;font-weight:600;color:#3A3833;margin-right:8px}
.sp-mark::first-letter{color:#CF4D24}
.sp-tab{display:flex;align-items:center;gap:8px;padding:7px 13px;border-radius:9px;font:inherit;font-size:12.5px;color:#6A685F;background:transparent;border:1px solid transparent;cursor:pointer}
.sp-tab .sp-tab-e{font-size:14px}
.sp-tab.is-active{background:#FBFAF6;border-color:#D2CFC6;color:#1C1B18;box-shadow:0 1px 2px rgba(30,28,24,.05)}
.sp-run{width:7px;height:7px;border-radius:50%;background:#CF4D24}
.sp-tab-add{color:#8A8678;border:1px dashed #CFCBC1}
.sp-mut{font-family:"Geist Mono",monospace;font-size:11px;color:#9A968A}
.sp-cols{flex:1;display:grid;min-height:0}
.sp-cols.cols-2{grid-template-columns:1fr 1fr}
.sp-cols.cols-3{grid-template-columns:1fr 1fr 1fr}
.sp-pane{position:relative;display:flex;flex-direction:column;min-width:0;border-right:1px solid #D8D4CB;transition:.2s}
.sp-pane:last-child{border-right:0}
.sp-pane.is-dim{opacity:.62}
.sp-pane.is-active{background:rgba(251,250,246,.4)}
.sp-pane-head{display:flex;align-items:center;gap:9px;padding:12px 18px;border-bottom:1px solid #E4E0D6}
.sp-pane-e{font-size:16px}
.sp-pane-n{font-size:13.5px;font-weight:600;flex:1}
.sp-pane-st{font-family:"Geist Mono",monospace;font-size:11px;color:#9A968A}
.sp-pane-st.is-working{color:#CF4D24}
.sp-stream{flex:1;overflow:auto;padding:22px 18px}
.sp-stream .ob-body p{font-size:14.5px;line-height:1.62}
.sp-stream .ob-turn{margin-bottom:20px;gap:12px}
.sp-stream .ob-tile{width:30px;height:30px;font-size:14px}
.sp-tray{padding:12px 16px;border-top:1px solid #E4E0D6}
.sp-pane.is-dim .ob-tray{opacity:.7}

/* ---- STAGE ---- */
.st-root{display:flex;flex-direction:column}
.st-top{display:flex;align-items:center;gap:8px;padding:16px 22px 0;font-size:13px;font-weight:500;color:#3A3833}
.st-top-mut{font-family:"Geist Mono",monospace;font-size:11.5px;color:#9A968A;font-weight:400}
.st-stage{flex:1;position:relative;display:flex;flex-direction:column;align-items:center;min-height:0}
.st-thread{padding-top:30px;padding-bottom:40px}
.st-trayWrap{position:absolute;left:0;right:0;bottom:26px;display:flex;justify-content:center}
.st-dock{flex:0 0 auto;display:flex;gap:12px;padding:16px 22px 20px;border-top:1px solid #D8D4CB;background:rgba(250,247,239,.6);overflow-x:auto}
.st-card{width:212px;flex:0 0 auto;padding:12px 14px;border-radius:12px;background:#FBFAF6;border:1px solid #D2CFC6;box-shadow:0 1px 2px rgba(30,28,24,.05);cursor:pointer;transition:.16s}
.st-card:hover{transform:translateY(-2px);box-shadow:0 6px 18px rgba(40,36,28,.1)}
.st-card.is-onstage{border-color:#1C1B18;box-shadow:0 0 0 1.5px #1C1B18,0 8px 22px rgba(40,36,28,.12);transform:translateY(-2px)}
.st-card-top{display:flex;align-items:center;gap:8px}
.st-card-e{font-size:15px}
.st-card-n{font-size:12px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st-card-live{width:8px;height:8px;border-radius:50%;background:#CF4D24;animation:obBlink 1.4s steps(1) infinite}
.st-card-badge{min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#1C1B18;color:#fff;font-size:10px;font-weight:600;display:grid;place-items:center}
.st-card-title{font-size:13px;font-weight:550;margin-top:8px}
.st-card-snip{font-size:11.5px;color:#8A8678;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st-card-add{width:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:#8A8678;border-style:dashed;background:transparent;font-size:20px}
.st-card-add span{font-size:11px}
`
