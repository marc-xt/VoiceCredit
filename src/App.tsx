import { useEffect, useMemo, useState } from 'react'

type TransactionType = 'credit' | 'payment' | 'adjustment'
type View = 'overview' | 'transactions' | 'customers' | 'reports'
type Language = 'lug' | 'swa' | 'eng'
type User = { id: string; name: string; email: string; created_at: string }
type AuthResponse = { token: string; user: User }

type Transaction = {
  id: string
  type: TransactionType
  customer: string
  item: string
  amount: number
  time: string
}

type ApiTransaction = Omit<Transaction, 'time'> & { timestamp: string }
type QueuedTransaction = Omit<Transaction, 'id' | 'time'> & { localId: string }

const API_BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')
const formatMoney = (amount: number) => `₦${amount.toLocaleString('en-NG')}`
const formatTime = (timestamp: string) => new Date(timestamp).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })
const mapTransaction = (transaction: ApiTransaction): Transaction => ({ ...transaction, time: formatTime(transaction.timestamp) })
const languageNames: Record<Language, string> = { lug: 'Luganda', swa: 'Swahili', eng: 'English' }
const commandExamples: Record<Language, string[]> = {
  lug: ['Naguze matooke tatu, credit ya John', 'Mbulira ebya leero', 'Ani alina bize?'],
  swa: ['Mpe bidhaa kwa deni', 'Muhtasari wa leo', 'Nani ananidai?'],
  eng: ['Give John three bananas on credit', 'Today’s summary', 'Who owes me?'],
}

function speak(text: string, language: Language) {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = language === 'lug' ? 'lg-UG' : language === 'swa' ? 'sw-KE' : 'en-UG'
  window.speechSynthesis.speak(utterance)
}

function App() {
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('voicecredit-token') ?? '')
  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authName, setAuthName] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [transactions, setTransactions] = useState<Transaction[]>(() => JSON.parse(localStorage.getItem('voicecredit-transactions') ?? '[]'))
  const [queuedTransactions, setQueuedTransactions] = useState<QueuedTransaction[]>(() => JSON.parse(localStorage.getItem('voicecredit-queue') ?? '[]'))
  const [activeView, setActiveView] = useState<View>('overview')
  const [language, setLanguage] = useState<Language>(() => (localStorage.getItem('voicecredit-language') as Language) || 'eng')
  const [isRecording, setIsRecording] = useState(false)
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [message, setMessage] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [customer, setCustomer] = useState('')
  const [item, setItem] = useState('')
  const [amount, setAmount] = useState('')
  const [transactionType, setTransactionType] = useState<TransactionType>('credit')

  const apiFetch = (path: string, options: RequestInit = {}) => fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
  })

  useEffect(() => {
    if (!authToken) { setAuthChecked(true); return }
    void fetch(`${API_BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${authToken}` } }).then(async (response) => {
      if (!response.ok) throw new Error('Session expired')
      setUser((await response.json()) as User)
    }).catch(() => {
      localStorage.removeItem('voicecredit-token')
      setAuthToken('')
      setUser(null)
    }).finally(() => setAuthChecked(true))
  }, [authToken])

  const submitAuth = async (event: React.FormEvent) => {
    event.preventDefault()
    setAuthBusy(true); setAuthError('')
    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register'
      const body = authMode === 'login' ? { email: authEmail, password: authPassword } : { name: authName, email: authEmail, password: authPassword }
      const response = await fetch(`${API_BASE_URL}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = (await response.json()) as AuthResponse & { detail?: string }
      if (!response.ok) throw new Error(result.detail ?? 'Authentication failed')
      localStorage.setItem('voicecredit-token', result.token)
      setAuthToken(result.token); setUser(result.user); setAuthPassword(''); setAuthChecked(true)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed')
    } finally { setAuthBusy(false) }
  }

  const logout = async () => {
    try { await apiFetch('/api/auth/logout', { method: 'POST' }) } finally {
      localStorage.removeItem('voicecredit-token'); setAuthToken(''); setUser(null); setTransactions([])
    }
  }

  useEffect(() => localStorage.setItem('voicecredit-transactions', JSON.stringify(transactions)), [transactions])
  useEffect(() => localStorage.setItem('voicecredit-queue', JSON.stringify(queuedTransactions)), [queuedTransactions])
  useEffect(() => localStorage.setItem('voicecredit-language', language), [language])

  const syncQueue = async () => {
    if (!queuedTransactions.length) return
    const remaining: QueuedTransaction[] = []
    for (const queued of queuedTransactions) {
      try {
        const { localId, type, ...transactionPayload } = queued
        const response = await apiFetch('/api/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...transactionPayload, transaction_type: type }) })
        if (!response.ok) throw new Error('sync failed')
        const saved = (await response.json()) as ApiTransaction
        setTransactions((current) => current.map((transaction) => transaction.id === localId ? mapTransaction(saved) : transaction))
      } catch {
        remaining.push(queued)
      }
    }
    setQueuedTransactions(remaining)
    if (!remaining.length) setMessage('Offline transactions synced.')
  }

  useEffect(() => {
    if (!authToken || !user) return
    const loadTransactions = async () => {
      try {
        const response = await apiFetch('/api/transactions')
        if (!response.ok) throw new Error('Backend unavailable')
        const data = (await response.json()) as ApiTransaction[]
        setTransactions(data.map(mapTransaction))
        setConnection('online')
      } catch {
        setConnection('offline')
        setMessage('Backend unavailable. Your records remain available offline.')
      }
    }
    void loadTransactions()
  }, [authToken, user])

  useEffect(() => {
    if (!authToken || !user || !queuedTransactions.length) return
    const syncWhenOnline = () => { void syncQueue() }
    window.addEventListener('online', syncWhenOnline)
    if (navigator.onLine) syncWhenOnline()
    return () => window.removeEventListener('online', syncWhenOnline)
  }, [authToken, user, queuedTransactions])

  const summary = useMemo(() => {
    const credit = transactions.filter((transaction) => transaction.type === 'credit').reduce((total, transaction) => total + transaction.amount, 0)
    const payments = transactions.filter((transaction) => transaction.type === 'payment').reduce((total, transaction) => total + transaction.amount, 0)
    const customers = new Set(transactions.map((transaction) => transaction.customer)).size
    return { credit, payments, outstanding: credit - payments, customers }
  }, [transactions])

  const customerBalances = useMemo(() => {
    const balances = new Map<string, number>()
    transactions.forEach((transaction) => balances.set(transaction.customer, (balances.get(transaction.customer) ?? 0) + (transaction.type === 'payment' ? -transaction.amount : transaction.amount)))
    return [...balances.entries()].sort((first, second) => second[1] - first[1])
  }, [transactions])

  const announceSummary = () => {
    const text = `Today's sales are ${formatMoney(summary.credit)}. Payments collected are ${formatMoney(summary.payments)}. Outstanding credit is ${formatMoney(summary.outstanding)}.`
    setMessage(text)
    speak(text, language)
  }

  const addTransaction = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!customer || !item || !amount || isSaving) return
    setIsSaving(true)
    const payload = { customer, item, amount: Number(amount), transaction_type: transactionType }
    try {
      const response = await apiFetch('/api/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!response.ok) throw new Error('Could not save transaction')
      const saved = (await response.json()) as ApiTransaction
      setTransactions((current) => [mapTransaction(saved), ...current])
      setConnection('online')
    } catch {
      const localId = crypto.randomUUID()
      setTransactions((current) => [{ id: localId, type: transactionType, customer, item, amount: Number(amount), time: 'Just now' }, ...current])
      setQueuedTransactions((current) => [...current, { customer, item, amount: Number(amount), type: transactionType, localId }])
      setConnection('offline')
      setMessage('Saved locally. It will sync when the backend is available.')
    } finally {
      setIsSaving(false)
    }
    speak(transactionType === 'payment' ? `Payment recorded for ${customer}.` : `Credit recorded. ${customer} owes ${formatMoney(Number(amount))}.`, language)
    setCustomer(''); setItem(''); setAmount(''); setShowForm(false)
  }

  const deleteTransaction = async (transaction: Transaction) => {
    try { await apiFetch(`/api/transactions/${transaction.id}`, { method: 'DELETE' }) } catch { /* local retention still applies */ }
    setTransactions((current) => current.filter((itemToRemove) => itemToRemove.id !== transaction.id))
    setMessage('Record deleted from this device.')
  }

  const startRecording = async () => {
    if (!navigator.mediaDevices || !window.MediaRecorder) { setMessage('Voice recording is not supported in this browser.'); return }
    setMessage(''); setIsRecording(true)
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) } catch { setIsRecording(false); setMessage('Microphone permission is required for voice recording.'); return }
    const recorder = new MediaRecorder(stream); const chunks: Blob[] = []
    recorder.ondataavailable = (event) => event.data.size > 0 && chunks.push(event.data)
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop())
      const formData = new FormData(); formData.append('audio', new Blob(chunks, { type: recorder.mimeType }), 'voice-command.webm'); formData.append('language', language)
      try {
        const response = await apiFetch('/api/transcribe', { method: 'POST', body: formData }); const result = (await response.json()) as { transcript?: string; detail?: string }
        if (!response.ok) throw new Error(result.detail ?? 'Transcription failed')
        const transcript = result.transcript ?? 'No words detected'; setMessage(`Heard: “${transcript}”`); speak(transcript, language)
      } catch (error) { setMessage(error instanceof Error ? error.message : 'Transcription failed') }
    }
    recorder.start(); window.setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); setIsRecording(false) }, 2200)
  }

  const renderForm = () => showForm && <form className="transaction-form" onSubmit={(event) => void addTransaction(event)}><input aria-label="Customer name" placeholder="Customer name" value={customer} onChange={(event) => setCustomer(event.target.value)} /><input aria-label="Item or reason" placeholder="Item or reason" value={item} onChange={(event) => setItem(event.target.value)} /><input aria-label="Amount" placeholder="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} /><select aria-label="Transaction type" value={transactionType} onChange={(event) => setTransactionType(event.target.value as TransactionType)}><option value="credit">Credit sale</option><option value="payment">Payment received</option></select><button type="submit" disabled={isSaving}>{isSaving ? 'Saving...' : 'Save record'}</button></form>

  const renderLedger = (items: Transaction[]) => <div className="table-wrap"><div className="table-header"><span>Customer</span><span>Details</span><span>Amount</span><span>Time</span><span /></div>{items.length ? items.map((transaction) => <div className="transaction-row" key={transaction.id}><div className="customer-cell"><div className={`customer-avatar ${transaction.type}`}>{transaction.customer.split(' ').map((name) => name[0]).join('')}</div><strong>{transaction.customer}</strong></div><span className="details-cell"><i className={transaction.type} />{transaction.item}</span><strong className={`amount ${transaction.type}`}>{transaction.type === 'payment' ? '+' : ''}{formatMoney(transaction.amount)}</strong><span className="time-cell">{transaction.time}</span><button className="row-menu" aria-label={`Delete ${transaction.customer} record`} onClick={() => void deleteTransaction(transaction)}>×</button></div>) : <div className="empty-state">No records yet. Tap “Add manually” or use your voice.</div>}</div>

  const viewContent = activeView === 'customers' ? <section className="page-section"><div className="section-heading"><div><span className="section-label">People you serve</span><h2>Customer balances</h2></div><button className="add-button" onClick={() => setShowForm(true)}>+ Add record</button></div><div className="customer-grid">{customerBalances.length ? customerBalances.map(([name, balance]) => <article className="customer-card" key={name}><div className="customer-card-head"><div className="customer-avatar">{name.split(' ').map((part) => part[0]).join('')}</div><button className="speak-button" onClick={() => speak(`${name} owes ${formatMoney(balance)}`, language)} aria-label={`Hear ${name} balance`}>◖</button></div><strong>{name}</strong><small>Outstanding balance</small><b className={balance > 0 ? 'debt' : 'paid'}>{balance > 0 ? formatMoney(balance) : 'Settled'}</b></article>) : <div className="empty-state">Customers appear here as you record credit sales and payments.</div>}</div></section> : activeView === 'reports' ? <section className="page-section"><div className="section-heading"><div><span className="section-label">Listen or read</span><h2>Daily report</h2></div><button className="add-button" onClick={announceSummary}>◖ Hear report</button></div><div className="report-banner"><div><span className="section-label">Today’s performance</span><strong>{formatMoney(summary.credit + summary.payments)}</strong><p>in recorded sales and payments</p></div><div className="report-bars"><i style={{ height: `${Math.min(100, summary.credit ? (summary.credit / (summary.credit + summary.payments)) * 100 : 0)}%` }} /><i style={{ height: `${Math.min(100, summary.payments ? (summary.payments / (summary.credit + summary.payments)) * 100 : 0)}%` }} /></div></div><div className="report-grid"><div className="report-list"><h3>Outstanding debts</h3>{customerBalances.filter(([, balance]) => balance > 0).map(([name, balance]) => <div className="debt-line" key={name}><span>{name}</span><strong>{formatMoney(balance)}</strong></div>)}{!customerBalances.some(([, balance]) => balance > 0) && <p className="muted">No outstanding debts.</p>}</div><div className="report-list"><h3>What the app can hear</h3>{commandExamples[language].map((example) => <button className="command-example" key={example} onClick={() => { setMessage(`Try saying: “${example}”`); speak(example, language) }}>◖ {example}</button>)}</div></div></section> : activeView === 'transactions' ? <section className="page-section"><div className="section-heading"><div><span className="section-label">Every record</span><h2>Transaction ledger</h2></div><button className="add-button" onClick={() => setShowForm((open) => !open)}>+ Add manually</button></div>{renderForm()}{renderLedger(transactions)}</section> : <><div className="hero-row"><section className="welcome-panel"><div><span className="section-label">Your day at a glance</span><h2>Keep business moving,<br /><em>just say it.</em></h2><p>Record a sale or payment in seconds. Your ledger stays with you, even offline.</p></div><div className="voice-area"><button className={`voice-button ${isRecording ? 'recording' : ''}`} onClick={() => void startRecording()} disabled={isRecording} aria-label="Record a voice transaction"><span className="mic-glyph">⌕</span></button><span>{isRecording ? 'Listening...' : 'Tap to record'}</span><small>{commandExamples[language][0]}</small></div></section><section className="today-card"><div className="card-head"><span className="section-label">Today</span><span className="trend">{transactions.length} records</span></div><strong className="today-total">{formatMoney(summary.credit)}</strong><p>in credit sales</p><div className="sparkline"><span /><span /><span /><span /><span /><span /><span /></div><div className="card-foot"><span>{summary.customers} customers</span><button className="text-button" onClick={announceSummary}>Hear summary →</button></div></section></div><section className="stats-grid"><div className="stat-card"><span className="stat-icon green">↗</span><div><small>Payments collected</small><strong>{formatMoney(summary.payments)}</strong><span className="positive">Available offline</span></div></div><div className="stat-card"><span className="stat-icon coral">◌</span><div><small>Outstanding credit</small><strong>{formatMoney(summary.outstanding)}</strong><span className="muted">from {customerBalances.filter(([, balance]) => balance > 0).length} customers</span></div></div><div className="stat-card"><span className="stat-icon yellow">◎</span><div><small>Active customers</small><strong>{summary.customers}</strong><span className="positive">Private by design</span></div></div></section><section className="transactions-section"><div className="section-heading"><div><span className="section-label">Ledger</span><h2>Recent transactions</h2></div><div className="heading-actions"><button className="text-button" onClick={() => setActiveView('transactions')}>View all <span>→</span></button><button className="add-button" onClick={() => setShowForm((open) => !open)}>+ Add manually</button></div></div>{renderForm()}{renderLedger(transactions.slice(0, 5))}</section></>

  if (!authChecked) return <main className="auth-screen"><div className="auth-card"><div className="brand-mark auth-brand"><span>VC</span><strong>VoiceCredit</strong></div><p className="auth-loading">Checking your account...</p></div></main>
  if (!user) return <main className="auth-screen"><div className="auth-card"><div className="brand-mark auth-brand"><span>VC</span><strong>VoiceCredit</strong></div><span className="section-label">Private bookkeeping</span><h1>{authMode === 'login' ? 'Welcome back' : 'Create your account'}</h1><p className="auth-copy">Your customer records stay tied to your account. No tax IDs, contacts, or location data.</p><form className="auth-form" onSubmit={(event) => void submitAuth(event)}>{authMode === 'register' && <input aria-label="Your name" placeholder="Your name" value={authName} onChange={(event) => setAuthName(event.target.value)} required />}<input aria-label="Email" type="email" placeholder="Email address" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required /><input aria-label="Password" type="password" placeholder="Password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} minLength={8} required />{authError && <p className="auth-error" role="alert">{authError}</p>}<button className="auth-submit" type="submit" disabled={authBusy}>{authBusy ? 'Please wait...' : authMode === 'login' ? 'Sign in' : 'Create account'}</button></form><button className="auth-switch" onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError('') }}>{authMode === 'login' ? 'Need an account? Create one' : 'Already have an account? Sign in'}</button></div></main>

  return <main className="app-shell"><aside className="sidebar"><div className="brand-mark"><span>VC</span><strong>VoiceCredit</strong></div><nav className="nav-list" aria-label="Primary navigation">{([['overview', '◈', 'Overview'], ['transactions', '▤', 'Transactions'], ['customers', '◎', 'Customers'], ['reports', '▥', 'Reports']] as [View, string, string][]).map(([view, icon, label]) => <button className={`nav-item ${activeView === view ? 'active' : ''}`} key={view} onClick={() => setActiveView(view)}><span className="nav-icon">{icon}</span>{label}</button>)}</nav><div className="sidebar-foot"><div className="offline-status"><span className="status-dot" /> {connection === 'online' ? 'Backend connected' : connection === 'connecting' ? 'Connecting...' : 'Offline ready'}</div><div className="profile"><div className="avatar">{user.name.split(' ').map((part) => part[0]).join('')}</div><div><strong>{user.name}</strong><small>{user.email}</small></div><button className="logout-button" onClick={() => void logout()} aria-label="Sign out">↪</button></div></div></aside><section className="content"><header className="topbar"><div><p className="eyebrow">Voice-first bookkeeping</p><h1>{activeView === 'overview' ? `Good morning, ${user.name}` : activeView === 'customers' ? 'Know who owes you' : activeView === 'reports' ? 'Your business, spoken clearly' : 'Every transaction, accounted for'} <span>✦</span></h1></div><label className="language-picker">Language<select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>{Object.entries(languageNames).map(([code, name]) => <option value={code} key={code}>{name}</option>)}</select></label></header>{message && <p className="app-message" role="status">{message}</p>}{viewContent}<footer><span><span className="status-dot" /> {connection === 'online' ? 'Synced with backend' : queuedTransactions.length ? `${queuedTransactions.length} change${queuedTransactions.length > 1 ? 's' : ''} waiting to sync` : 'All changes saved locally'}</span><span>VoiceCredit · No tax IDs, contacts, or location collected</span></footer></section></main>
}

export default App
