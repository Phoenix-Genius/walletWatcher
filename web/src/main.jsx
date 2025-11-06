import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'

// Small helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fetchJSON = async (url, opts) => {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

function usePolling(fn, deps, intervalMs = 2000) {
  useEffect(() => {
    let stop = false
    let t
    const tick = async () => {
      try { await fn() } finally { if (!stop) t = setTimeout(tick, intervalMs) }
    }
    tick()
    return () => { stop = true; clearTimeout(t) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

function Badge({ ok, children }) {
  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap:8, padding:'4px 10px', borderRadius:999,
      color: ok ? '#065f46' : '#7f1d1d', background: ok ? '#d1fae5' : '#fee2e2', border:`1px solid ${ok ? '#34d399' : '#fca5a5'}`
    }}>{children}</span>
  )
}

function App() {
  const [cfg, setCfg] = useState([])
  const [status, setStatus] = useState({ running: false })
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const [form, setForm] = useState({ only: '', interval: 30000, usdDelta: 0.1, concurrency: 50 })
  const [quick, setQuick] = useState({ address:'', label:'', email:'' })
  const [cfgText, setCfgText] = useState('[]')
  const cfgError = useMemo(() => {
    try { JSON.parse(cfgText); return '' } catch (e) { return e.message }
  }, [cfgText])

  async function loadAll() {
    try {
      const [c, s] = await Promise.all([
        fetchJSON('/api/wallets'),
        fetchJSON('/api/status'),
      ])
      setCfg(c); setCfgText(JSON.stringify(c, null, 2)); setStatus(s)
    } catch (e) { setErr(String(e.message || e)); await sleep(800); setErr('') }
  }
  useEffect(() => { loadAll() }, [])
  usePolling(async () => { try { const s = await fetchJSON('/api/status'); setStatus(s) } catch { /* ignore transient */ } }, [setStatus], 2000)
  usePolling(async () => { try { const r = await fetchJSON('/api/logs?limit=200'); setLogs(r.lines || []) } catch { /* ignore */ } }, [setStatus], 2000)

  const [logs, setLogs] = useState([])
  async function startWatcher() {
    setLoading(true); setMsg(''); setErr('')
    try {
      const body = { ...form }
      if (!body.only) delete body.only
      if (!body.usdDelta || isNaN(body.usdDelta)) delete body.usdDelta
      if (!body.interval || isNaN(body.interval)) delete body.interval
      if (!body.concurrency || isNaN(body.concurrency)) delete body.concurrency
      await fetchJSON('/api/watcher/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
      await loadAll()
      setMsg('Watcher started')
    } catch (e) { setErr(`Start failed: ${String(e.message || e)}`) } finally { setLoading(false); setTimeout(()=>setMsg(''), 1500) }
  }
  async function stopWatcher() {
    setLoading(true); setMsg(''); setErr('')
    try {
      await fetch('/api/watcher/stop', { method:'POST' })
      await loadAll()
      setMsg('Watcher stopped')
    } catch (e) { setErr(`Stop failed: ${String(e.message || e)}`) } finally { setLoading(false); setTimeout(()=>setMsg(''), 1500) }
  }
  async function saveCfg() {
    setLoading(true); setMsg(''); setErr('')
    try {
      const next = JSON.parse(cfgText)
      await fetch('/api/wallets', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(next) })
      setCfg(next)
      setMsg('Config saved')
    } catch (e) { setErr(`Save failed: ${String(e.message || e)}`) } finally { setLoading(false); setTimeout(()=>setMsg(''), 1500) }
  }

  return (
    <div style={{ padding: 20, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', maxWidth: 1000, margin:'0 auto' }}>
      <style>{`
        .row{display:flex;gap:12px;align-items:center}
        .col{display:flex;flex-direction:column;gap:6px}
        .card{border:1px solid #e5e7eb;border-radius:10px;padding:16px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.04)}
        label{font-size:12px;color:#374151}
        input,textarea{border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:14px;font-family:inherit}
        textarea{min-height:240px;resize:vertical}
        .btn{border:none;border-radius:8px;padding:8px 12px;font-weight:600;cursor:pointer}
        .btn:disabled{opacity:.6;cursor:not-allowed}
        .btn.primary{background:#2563eb;color:#fff}
        .btn.secondary{background:#e5e7eb}
        .btn.danger{background:#ef4444;color:#fff}
        .muted{color:#6b7280}
        .spacer{height:16px}
      `}</style>
      <h1 style={{margin:'6px 0 16px'}}>Wallet Watcher</h1>

      <div className="card" style={{marginBottom:16}}>
        <div className="row" style={{justifyContent:'space-between'}}>
          <div className="row" style={{gap:10}}>
            <Badge ok={!!status.running}>{status.running ? 'Running' : 'Stopped'}</Badge>
            <span className="muted">Status updates every 2s</span>
          </div>
          <div className="row">
            <button className="btn primary" disabled={loading || status.running} onClick={startWatcher}>Start</button>
            <button className="btn danger" disabled={loading || !status.running} onClick={stopWatcher}>Stop</button>
            <button className="btn secondary" disabled={loading} onClick={loadAll}>Refresh</button>
          </div>
        </div>
        {msg && <div style={{marginTop:8,color:'#065f46',background:'#ecfdf5',border:'1px solid #a7f3d0',borderRadius:8,padding:'8px 10px'}}>{msg}</div>}
        {err && <div style={{marginTop:8,color:'#7f1d1d',background:'#fef2f2',border:'1px solid #fecaca',borderRadius:8,padding:'8px 10px'}}>{err}</div>}
      </div>

  <div className="row" style={{gap:16, alignItems:'flex-start'}}>
        <div className="card" style={{flex:1}}>
          <h2 style={{marginTop:0}}>Watcher settings</h2>
          <div className="row" style={{gap:12, flexWrap:'wrap'}}>
            <div className="col" style={{minWidth:220}}>
              <label>Only networks (comma, optional)</label>
              <input placeholder="eth,polygon,bsc" value={form.only} onChange={e=>setForm(f=>({ ...f, only: e.target.value }))} />
              <small className="muted">Leave empty to scan all supported networks.</small>
            </div>
            <div className="col" style={{minWidth:160}}>
              <label>Interval (ms)</label>
              <input type="number" min={5000} step={1000} value={form.interval} onChange={e=>setForm(f=>({ ...f, interval: Number(e.target.value) }))} />
            </div>
            <div className="col" style={{minWidth:160}}>
              <label>USD delta threshold</label>
              <input type="number" step="0.01" min={0} value={form.usdDelta} onChange={e=>setForm(f=>({ ...f, usdDelta: Number(e.target.value) }))} />
            </div>
            <div className="col" style={{minWidth:160}}>
              <label>Concurrency</label>
              <input type="number" min={1} value={form.concurrency} onChange={e=>setForm(f=>({ ...f, concurrency: Number(e.target.value) }))} />
            </div>
          </div>
          <div className="spacer"/>
          <div className="row">
            <button className="btn primary" disabled={loading || status.running} onClick={startWatcher}>Start watcher</button>
            <button className="btn danger" disabled={loading || !status.running} onClick={stopWatcher}>Stop watcher</button>
          </div>
        </div>

  <div className="card" style={{flex:1}}>
          <h2 style={{marginTop:0}}>Config (wallets.json)</h2>
          <div className="muted" style={{marginBottom:6}}>
            Tip: You can add non‑EVM wallets using prefixes: <code>sol:ADDRESS</code> or <code>tron:ADDRESS</code> (label and email still work).
          </div>
          <div className="row" style={{gap:8, flexWrap:'wrap', marginBottom:8}}>
            <input style={{minWidth:260}} placeholder="0x... wallet address" value={quick.address} onChange={e=>setQuick(q=>({...q,address:e.target.value}))} />
            <input style={{minWidth:160}} placeholder="label (optional)" value={quick.label} onChange={e=>setQuick(q=>({...q,label:e.target.value}))} />
            <input style={{minWidth:240}} placeholder="email (optional)" value={quick.email} onChange={e=>setQuick(q=>({...q,email:e.target.value}))} />
            <button className="btn secondary" onClick={()=>{
              try{
                const data = JSON.parse(cfgText || '[]')
                const entry = [quick.address, quick.label, quick.email].filter(Boolean).join(' ')
                if (!entry) return
                if (Array.isArray(data) && data.length>0 && data[0] && typeof data[0]==='object'){
                  data[0].wallets = data[0].wallets || []
                  data[0].wallets.push(entry)
                } else {
                  data.splice(0,data.length, { user:'default', email:'', wallets:[entry] })
                }
                setCfgText(JSON.stringify(data,null,2))
                setQuick({address:'',label:'',email:''})
              }catch{ /* ignore */ }
            }}>Add wallet</button>
          </div>
          <textarea value={cfgText} onChange={e=>setCfgText(e.target.value)} spellCheck={false} />
          {cfgError ? (
            <div style={{marginTop:8,color:'#7f1d1d',background:'#fef2f2',border:'1px solid #fecaca',borderRadius:8,padding:'8px 10px'}}>JSON error: {cfgError}</div>
          ) : (
            <div className="muted" style={{marginTop:6}}>{Array.isArray(cfg) ? `${cfg.length} user(s) configured` : 'Root must be an array of users'}</div>
          )}
          <div className="spacer"/>
          <div className="row">
            <button className="btn primary" disabled={loading || !!cfgError} onClick={saveCfg}>Save config</button>
            <button className="btn secondary" disabled={loading} onClick={()=>setCfgText(JSON.stringify(cfg, null, 2))}>Reformat</button>
            <button className="btn secondary" disabled={loading} onClick={loadAll}>Reload</button>
          </div>
        </div>
      </div>

      <div className="spacer"/>
      <div className="card">
        <h2 style={{marginTop:0}}>Watcher logs</h2>
        {!status.running && <div className="muted" style={{marginBottom:8}}>Watcher is stopped. Start it to see live logs.</div>}
        <pre style={{background:'#0b1020', color:'#d1e7ff', padding:10, borderRadius:8, maxHeight:280, overflow:'auto'}}>
{(logs && logs.length ? logs : ['<no logs>']).join('\n')}
        </pre>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
