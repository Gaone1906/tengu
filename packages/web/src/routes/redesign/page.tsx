import { useEffect, useMemo, useState } from 'react'

/* ============================================================
   DOCK shell × every skin.  /redesign?c=object|bureau|ink|ledger|halo
   One navigation structure (employee rail · chat list · focused
   conversation · skin-native input), restyled per concept.
   &palette=1 shows the ⌘K switcher.  &bare=1 hides the top switcher.
   ============================================================ */

type Skin = 'object' | 'bureau' | 'ink' | 'ledger' | 'halo'
const SKINS: { id: Skin; label: string }[] = [
  { id: 'object', label: 'Object' },
  { id: 'bureau', label: 'Bureau' },
  { id: 'ink', label: 'Ink' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'halo', label: 'Halo' },
]
/* which input element each skin uses */
const INPUT: Record<Skin, 'tray' | 'bar' | 'pill' | 'line'> = {
  object: 'tray', bureau: 'bar', ledger: 'bar', halo: 'pill', ink: 'line',
}

const E = { jimbo: '\u{1F3A9}', dev: '\u{1F9D1}‍\u{1F4BB}', pravko: '⚖️', movekit: '\u{1F4E6}', cos: '\u{1F4CB}', reddit: '\u{1F47D}' }
const SAMPLE = {
  user1: 'What’s the status on the MoveKit billing fix?',
  reply: 'The AVS / billing-address fix shipped to all MoveKit Checkout Sessions — `billing_address_collection: "required"`. Conversion held flat through the first 48 hours, so no regression. I’ve queued the 30-day review for June 17. Want me to wire a PostHog funnel alert in the meantime?',
}
const EMPLOYEES = [
  { id: 'jimbo', emoji: E.jimbo, name: 'Jimbo', state: 'idle', unread: 0 },
  { id: 'jinn-dev', emoji: E.dev, name: 'Jinn Dev', state: 'working', unread: 0 },
  { id: 'movekit', emoji: E.movekit, name: 'MoveKit Support', state: 'working', unread: 2 },
  { id: 'pravko', emoji: E.pravko, name: 'Pravko Lead', state: 'idle', unread: 0 },
  { id: 'cos', emoji: E.cos, name: 'Chief of Staff', state: 'idle', unread: 1 },
  { id: 'reddit', emoji: E.reddit, name: 'Reddit Scout', state: 'idle', unread: 0 },
]
const DEV_CHATS = [
  { title: 'MoveKit billing fix', snippet: 'queued the 30-day review…', state: 'working' },
  { title: 'Gateway WS reconnect', snippet: 'patched the boot-guard', state: 'idle' },
  { title: 'Redesign showcase', snippet: 'dock shell, five skins', state: 'idle' },
]
function mdLite(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function Input({ skin, value }: { skin: Skin; value: string }) {
  const t = INPUT[skin]
  if (t === 'tray') return (
    <div className="dk-inWrap dk-inFloat">
      <div className="dk-tray">
        <button className="dk-tray-agent">{E.dev}</button>
        <div className="dk-tray-in">{value || <span className="dk-ph">Message jinn, or @ an employee</span>}<span className="dk-caret" /></div>
        <button className="dk-tray-mic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3v18M7 7v10M17 7v10M3 11v2M21 11v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></button>
        <button className="dk-tray-send"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      </div>
      <div className="dk-hint">⌘1–9 jump to agent · ⌘K switch · @ route · / command</div>
    </div>
  )
  if (t === 'pill') return (
    <div className="dk-inWrap dk-inFloat">
      <div className="dk-pill">
        <button className="dk-pill-agent">{E.dev}</button>
        <div className="dk-pill-in">{value || <span className="dk-ph">Ask anything, or summon an agent with @</span>}<span className="dk-caret" /></div>
        <button className="dk-pill-mic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 3v18M7 7v10M17 7v10M3 11v2M21 11v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></button>
        <button className="dk-pill-send"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>
      </div>
      <div className="dk-hint">@ agent · / command · ⏎ send</div>
    </div>
  )
  if (t === 'line') return (
    <div className="dk-inWrap dk-inLine">
      <span className="dk-line-mono">JD</span>
      <div className="dk-line-in">{value || <span className="dk-ph">Write a line…</span>}<span className="dk-caret" /></div>
      <button className="dk-line-go">→</button>
    </div>
  )
  // bar
  return (
    <div className="dk-inWrap dk-inBar">
      <span className="dk-bar-sigil">›</span>
      <span className="dk-bar-in">{value || <span className="dk-ph">Message jinn…</span>}<span className="dk-caret" /></span>
      <span className="dk-bar-keys">⏎ send&nbsp;&nbsp;⌥⏎ newline&nbsp;&nbsp;/ cmd&nbsp;&nbsp;@ agent</span>
    </div>
  )
}

function DockShell({ skin, palette }: { skin: Skin; palette: boolean }) {
  const barInput = INPUT[skin] === 'bar'
  return (
    <div className="dk2" data-skin={skin}>
      {/* employee rail */}
      <aside className="dk-rail">
        <div className="dk-mark">◧</div>
        {EMPLOYEES.map((a, i) => (
          <button key={a.id} className={`dk-tile ${i === 1 ? 'is-active' : ''} ${a.state === 'working' ? 'is-working' : ''}`} title={a.name}>
            {a.emoji}{a.unread > 0 && <span className="dk-badge">{a.unread}</span>}
          </button>
        ))}
        <div className="dk-grow" />
        <button className="dk-tile dk-add">+</button>
      </aside>

      {/* chats of selected employee */}
      <aside className="dk-chats">
        <div className="dk-chats-head"><span className="dk-emp">{E.dev} Jinn Dev</span><span className="dk-emp-state">working</span></div>
        <button className="dk-search">Search agents & chats <kbd>⌘K</kbd></button>
        {DEV_CHATS.map((c, i) => (
          <div key={c.title} className={`dk-chat ${i === 0 ? 'is-active' : ''}`}>
            <div className="dk-chat-t">{c.title}{c.state === 'working' && <span className="dk-run" />}</div>
            <div className="dk-chat-s">{c.snippet}</div>
          </div>
        ))}
      </aside>

      {/* focused conversation */}
      <main className={`dk-main ${barInput ? 'has-bar' : ''}`}>
        <div className="dk-thread">
          <div className="dk-turn dk-turn-you">
            <div className="dk-av dk-av-you">H</div>
            <div className="dk-msg"><p>{SAMPLE.user1}</p></div>
          </div>
          <div className="dk-turn">
            <div className="dk-av">{E.dev}</div>
            <div className="dk-msg">
              <div className="dk-byline">JINN-DEV</div>
              <p dangerouslySetInnerHTML={{ __html: mdLite(SAMPLE.reply) }} />
              <div className="dk-tool">▪ ran 4 tools · 1.8s</div>
            </div>
          </div>
        </div>
        <Input skin={skin} value="Draft the PostHog funnel alert" />
      </main>

      {palette && (
        <div className="dk-overlay">
          <div className="dk-palette">
            <div className="dk-pal-input"><span>move</span><span className="dk-caret" /></div>
            <div className="dk-pal-group">EMPLOYEES</div>
            <div className="dk-pal-row is-sel">{E.movekit} <b>MoveKit Support</b><span className="dk-pal-mut">2 unread · working</span><kbd>↵</kbd></div>
            <div className="dk-pal-group">CHATS</div>
            <div className="dk-pal-row">{E.dev} MoveKit billing fix <span className="dk-pal-mut">Jinn Dev · working</span></div>
            <div className="dk-pal-row">{E.movekit} Refund — Pedro M. <span className="dk-pal-mut">MoveKit · awaiting ✅</span></div>
            <div className="dk-pal-foot"><span>↑↓ navigate</span><span>↵ open</span><span>⌘↵ open in split</span><span>esc</span></div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function RedesignPage() {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const initial = (params.get('c') as Skin) || 'object'
  const palette = params.get('palette') === '1'
  const hideSwitcher = params.get('bare') === '1'
  const [skin, setSkin] = useState<Skin>(SKINS.some((s) => s.id === initial) ? initial : 'object')

  useEffect(() => {
    document.documentElement.setAttribute('data-redesign', skin)
    return () => document.documentElement.removeAttribute('data-redesign')
  }, [skin])

  const body = useMemo(() => <DockShell skin={skin} palette={palette} />, [skin, palette])

  return (
    <div className="rd-shell">
      <style>{CSS}</style>
      {!hideSwitcher && (
        <div className="rd-switch">
          {SKINS.map((s) => (
            <button key={s.id} className={skin === s.id ? 'is-on' : ''} onClick={() => setSkin(s.id)}>{s.label}</button>
          ))}
        </div>
      )}
      {body}
    </div>
  )
}

const CSS = String.raw`
.rd-shell{position:fixed;inset:0;overflow:hidden}
.rd-switch{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:80;display:flex;gap:2px;padding:3px;border-radius:999px;background:rgba(20,20,24,.55);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.12)}
.rd-switch button{font:500 12px/1 ui-sans-serif,system-ui;letter-spacing:.02em;color:rgba(255,255,255,.62);background:transparent;border:0;padding:7px 16px;border-radius:999px;cursor:pointer;transition:.18s}
.rd-switch button.is-on{background:#fff;color:#111}

/* ---------- per-skin tokens ---------- */
.dk2[data-skin="object"]{--ink:#1C1B18;--soft:#6A685F;--faint:#9C988C;--line:#D2CFC6;--surface:#FBFAF6;--surface2:#F1EEE6;--accent:#CF4D24;--accentText:#fff;--font:"Geist",system-ui,sans-serif;--mono:"Geist Mono",ui-monospace,monospace;--tileR:9px;--railBg:rgba(250,247,239,.5);--code:rgba(120,116,104,.16);background:radial-gradient(130% 100% at 50% 0%,#EEEBE4,#E5E2DA)}
.dk2[data-skin="bureau"]{--ink:#23201A;--soft:#6B6457;--faint:#A49C8B;--line:#DED7C7;--surface:#FAF7EF;--surface2:#F2EDE2;--accent:#8A3A33;--accentText:#fff;--font:"Hanken Grotesk",system-ui,sans-serif;--mono:"IBM Plex Mono",monospace;--tileR:8px;--railBg:#EEE8DA;--code:rgba(120,110,90,.14);background:#F2EDE2}
.dk2[data-skin="ink"]{--ink:#1A1714;--soft:#6E665B;--faint:#ABA293;--line:#E1DBCF;--surface:#FBF8F1;--surface2:#EFEAE0;--accent:#1A1714;--accentText:#F4F1EA;--font:"Source Serif 4",Georgia,serif;--mono:"IBM Plex Mono",monospace;--tileR:50%;--railBg:#EFEAE0;--code:#E7E0D2;background:#F4F1EA}
.dk2[data-skin="ledger"]{--ink:#E8E4D8;--soft:#A8A290;--faint:#6E6957;--line:rgba(255,255,255,.09);--surface:rgba(255,255,255,.045);--surface2:rgba(255,255,255,.07);--accent:#E0A33C;--accentText:#14130F;--font:"Hanken Grotesk",system-ui,sans-serif;--mono:"IBM Plex Mono",monospace;--tileR:6px;--railBg:rgba(0,0,0,.25);--code:rgba(224,163,60,.14);background:#14130F}
.dk2[data-skin="halo"]{--ink:#ECE6F2;--soft:rgba(236,230,242,.62);--faint:rgba(236,230,242,.34);--line:rgba(255,255,255,.09);--surface:rgba(255,255,255,.05);--surface2:rgba(255,255,255,.08);--accent:#C9B6FF;--accentText:#1a1226;--font:"Hanken Grotesk",system-ui,sans-serif;--mono:"IBM Plex Mono",monospace;--tileR:12px;--railBg:rgba(255,255,255,.03);--code:rgba(201,182,255,.14);background:radial-gradient(120% 90% at 82% -8%,rgba(124,92,246,.13),transparent 52%),#141019}

/* ---------- shared DOCK layout (var-driven) ---------- */
.dk2{position:absolute;inset:0;display:flex;color:var(--ink);font-family:var(--font)}
.dk2 code{font-family:var(--mono);font-size:.82em;padding:.08em .35em;border-radius:5px;background:var(--code)}
.dk-rail{width:64px;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 0;border-right:1px solid var(--line);background:var(--railBg)}
.dk-mark{color:var(--accent);font-size:18px;margin-bottom:6px}
.dk-tile{position:relative;width:40px;height:40px;border-radius:var(--tileR);display:grid;place-items:center;font-size:18px;background:var(--surface);border:1px solid var(--line);cursor:pointer;transition:.16s;color:var(--ink)}
.dk-tile:hover{transform:translateY(-1px)}
.dk-tile.is-active{border-color:var(--accent);box-shadow:0 0 0 1.5px var(--accent)}
.dk-tile.is-working::after{content:"";position:absolute;top:-2px;right:-2px;width:9px;height:9px;border-radius:50%;background:var(--accent);border:2px solid var(--railBg)}
.dk-badge{position:absolute;bottom:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--accent);color:var(--accentText);font-size:10px;font-weight:600;display:grid;place-items:center;font-family:var(--mono)}
.dk-grow{flex:1}
.dk-add{font-size:20px;color:var(--faint);border-style:dashed;background:transparent}
.dk-chats{width:248px;flex:0 0 auto;border-right:1px solid var(--line);padding:16px 12px;display:flex;flex-direction:column;gap:6px}
.dk-chats-head{display:flex;align-items:baseline;justify-content:space-between;padding:2px 6px 6px}
.dk-emp{font-size:14px;font-weight:600}
.dk-emp-state{font-family:var(--mono);font-size:11px;color:var(--accent)}
.dk-search{display:flex;align-items:center;justify-content:space-between;width:100%;padding:9px 12px;border-radius:10px;background:var(--surface2);border:1px solid var(--line);color:var(--faint);font:inherit;font-size:13px;cursor:pointer;margin-bottom:6px}
.dk-search kbd{font-family:var(--mono);font-size:11px;background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:var(--soft)}
.dk-chat{padding:10px 12px;border-radius:10px;cursor:pointer}
.dk-chat:hover{background:var(--surface2)}
.dk-chat.is-active{background:var(--surface);border:1px solid var(--line)}
.dk-chat-t{font-size:13.5px;font-weight:550;display:flex;align-items:center;gap:7px}
.dk-run{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.dk-chat-s{font-size:12px;color:var(--soft);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dk-main{flex:1;position:relative;min-width:0;display:flex;flex-direction:column}
.dk-thread{flex:1;overflow:auto;width:min(680px,90%);margin:0 auto;padding:46px 0 150px}
.dk-main.has-bar .dk-thread{padding-bottom:90px}
.dk-turn{display:flex;gap:16px;margin-bottom:26px}
.dk-av{width:34px;height:34px;border-radius:var(--tileR);display:grid;place-items:center;font-size:16px;background:var(--surface);border:1px solid var(--line);flex:0 0 auto}
.dk-av-you{background:var(--accent);color:var(--accentText);font-weight:600;font-size:14px;border-color:transparent}
.dk-msg{flex:1}
.dk-turn-you .dk-msg p{color:var(--soft)}
.dk-byline{font-family:var(--mono);font-size:11px;letter-spacing:.08em;color:var(--accent);margin-bottom:6px}
.dk-msg p{font-size:15.5px;line-height:1.66;color:var(--ink)}
.dk-tool{margin-top:12px;font-family:var(--mono);font-size:11.5px;color:var(--faint)}

/* ---------- inputs ---------- */
.dk-ph{color:var(--faint)}
.dk-caret{display:inline-block;width:2px;height:18px;background:var(--accent);margin-left:1px;vertical-align:-3px;animation:dkBlink 1.1s steps(1) infinite}
@keyframes dkBlink{50%{opacity:0}}
.dk-inFloat{position:absolute;left:0;right:0;bottom:28px;display:flex;flex-direction:column;align-items:center;gap:9px}
.dk-hint{font-family:var(--mono);font-size:11px;color:var(--faint)}

/* tray (object) */
.dk-tray{display:flex;align-items:center;gap:8px;width:min(600px,86%);padding:9px;border-radius:14px;background:var(--surface);border:1px solid var(--line);box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 8px 28px rgba(40,36,28,.12),0 1px 3px rgba(40,36,28,.08)}
.dk-tray-agent{width:38px;height:38px;border-radius:9px;display:grid;place-items:center;font-size:17px;background:var(--surface2);border:1px solid var(--line);cursor:pointer;flex:0 0 auto;color:var(--ink)}
.dk-tray-in{flex:1;font-size:15.5px;color:var(--ink)}
.dk-tray-mic{width:38px;height:38px;border-radius:9px;display:grid;place-items:center;background:transparent;border:0;color:var(--soft);cursor:pointer;flex:0 0 auto}
.dk-tray-send{width:38px;height:38px;border-radius:9px;display:grid;place-items:center;background:var(--accent);color:var(--accentText);border:0;cursor:pointer;flex:0 0 auto;box-shadow:0 2px 8px rgba(0,0,0,.15)}

/* pill (halo) */
.dk-pill{position:relative;display:flex;align-items:center;gap:10px;width:min(600px,86%);padding:9px 10px;border-radius:999px;background:var(--surface2);border:1px solid var(--line);box-shadow:0 16px 44px rgba(0,0,0,.4)}
.dk-pill-agent{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-size:17px;background:rgba(201,182,255,.14);border:1px solid rgba(201,182,255,.3);cursor:pointer;flex:0 0 auto;color:var(--ink)}
.dk-pill-in{flex:1;font-size:15.5px;color:#fff}
.dk-pill-mic{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:transparent;border:0;color:var(--soft);cursor:pointer;flex:0 0 auto}
.dk-pill-send{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:var(--accent);color:var(--accentText);border:0;cursor:pointer;flex:0 0 auto}

/* line (ink) */
.dk-inLine{position:absolute;left:50%;transform:translateX(-50%);bottom:30px;width:min(620px,86%);display:flex;align-items:center;gap:16px;padding-top:16px;border-top:1px solid var(--ink)}
.dk-line-mono{font-family:"Fraunces",serif;font-size:13px;letter-spacing:.08em;border:1px solid var(--ink);border-radius:50%;width:30px;height:30px;display:grid;place-items:center;flex:0 0 auto}
.dk-line-in{flex:1;font-size:19px;color:var(--ink)}
.dk-line-in .dk-caret{height:23px;vertical-align:-4px}
.dk-line-go{width:36px;height:36px;border-radius:50%;border:1px solid var(--ink);background:transparent;color:var(--ink);font-size:18px;cursor:pointer;flex:0 0 auto}

/* bar (bureau, ledger) */
.dk-inBar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:12px;height:54px;padding:0 24px;border-top:1px solid var(--line);background:var(--surface2);font-family:var(--mono)}
.dk-bar-sigil{color:var(--accent);font-size:17px;font-weight:600}
.dk-bar-in{flex:1;font-size:14.5px;color:var(--ink)}
.dk-bar-keys{font-size:11px;color:var(--faint);white-space:nowrap}

/* ---------- ⌘K palette ---------- */
.dk-overlay{position:absolute;inset:0;background:rgba(20,18,14,.32);backdrop-filter:blur(2px);display:flex;justify-content:center;padding-top:13vh;z-index:20}
.dk-palette{width:min(560px,90%);height:max-content;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 30px 80px rgba(0,0,0,.4);overflow:hidden;font-family:var(--font)}
.dk-pal-input{display:flex;align-items:center;padding:18px 20px;font-size:18px;border-bottom:1px solid var(--line);color:var(--ink)}
.dk-pal-group{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;color:var(--faint);padding:12px 20px 4px}
.dk-pal-row{display:flex;align-items:center;gap:10px;padding:9px 20px;font-size:14px;cursor:pointer;color:var(--ink)}
.dk-pal-row .dk-pal-mut{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--faint)}
.dk-pal-row kbd{font-family:var(--mono);font-size:11px;background:var(--surface2);border-radius:4px;padding:1px 5px;margin-left:10px}
.dk-pal-row.is-sel{background:var(--surface2);box-shadow:inset 2px 0 0 var(--accent)}
.dk-pal-foot{display:flex;gap:16px;padding:11px 20px;border-top:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--faint)}
`
