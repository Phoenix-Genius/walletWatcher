import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

function App() {
  const [cfg, setCfg] = useState([])
  const [status, setStatus] = useState({ running: false })
  const [form, setForm] = useState({ only: '', interval: 30000, usdDelta: 0.1, concurrency: 50 })

  async function load() {
    const [c, s] = await Promise.all([
      fetch('/api/wallets').then(r => r.json()),
      fetch('/api/status').then(r => r.json()),
    ])
    setCfg(c); setStatus(s)
  }
  useEffect(() => { load() }, [])

  async function saveCfg(next) {
    await fetch('/api/wallets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) })
    setCfg(next)
  }

  return (
    <div style={{ padding: 20, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Wallet Watcher</h1>
      <section>
        <h2>Watcher</h2>
        <div>Running: {String(status.running)}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <input placeholder="only (comma keys)" value={form.only} onChange={e=>setForm(f=>({ ...f, only: e.target.value }))} />
          <input type="number" placeholder="interval" value={form.interval} onChange={e=>setForm(f=>({ ...f, interval: Number(e.target.value) }))} />
          <input type="number" step="0.01" placeholder="usdDelta" value={form.usdDelta} onChange={e=>setForm(f=>({ ...f, usdDelta: Number(e.target.value) }))} />
          <input type="number" placeholder="concurrency" value={form.concurrency} onChange={e=>setForm(f=>({ ...f, concurrency: Number(e.target.value) }))} />
          <button onClick={async()=>{ await fetch('/api/watcher/start', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(form) }); load() }}>Start</button>
          <button onClick={async()=>{ await fetch('/api/watcher/stop', { method: 'POST' }); load() }}>Stop</button>
        </div>
      </section>

      <section>
        <h2>Config (wallets.json)</h2>
        <pre style={{ background:'#f6f6f6', padding:10 }}>
{JSON.stringify(cfg, null, 2)}
        </pre>
      </section>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
