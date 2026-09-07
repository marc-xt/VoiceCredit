import { useEffect, useMemo, useState } from 'react'

type Transaction = {
  id: string
  type: 'credit' | 'payment'
  customer: string
  item: string
  amount: number
  time: string
}

const starterTransactions: Transaction[] = [
  { id: '1', type: 'credit', customer: 'Maya Okafor', item: '12kg rice', amount: 18500, time: 'Today, 10:42 AM' },
  { id: '2', type: 'payment', customer: 'Jon Bell', item: 'Payment received', amount: 8000, time: 'Today, 09:18 AM' },
  { id: '3', type: 'credit', customer: 'Amina Yusuf', item: 'Cooking oil + flour', amount: 12400, time: 'Yesterday, 04:26 PM' },
  { id: '4', type: 'credit', customer: 'Tunde Bakare', item: 'Phone accessories', amount: 6800, time: 'Yesterday, 01:05 PM' },
]

const formatMoney = (amount: number) => `₦${amount.toLocaleString('en-NG')}`

function App() {
  const [transactions, setTransactions] = useState<Transaction[]>(() => {
    const saved = localStorage.getItem('voicecredit-transactions')
    return saved ? JSON.parse(saved) : starterTransactions
  })
  const [isRecording, setIsRecording] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [customer, setCustomer] = useState('')
  const [item, setItem] = useState('')
  const [amount, setAmount] = useState('')

  useEffect(() => {
    localStorage.setItem('voicecredit-transactions', JSON.stringify(transactions))
  }, [transactions])

  const summary = useMemo(() => {
    const credit = transactions.filter((transaction) => transaction.type === 'credit').reduce((total, transaction) => total + transaction.amount, 0)
    const payments = transactions.filter((transaction) => transaction.type === 'payment').reduce((total, transaction) => total + transaction.amount, 0)
    return { credit, payments, outstanding: credit - payments }
  }, [transactions])

  const addTransaction = (event: React.FormEvent) => {
    event.preventDefault()
    if (!customer || !item || !amount) return
    setTransactions((current) => [{ id: crypto.randomUUID(), type: 'credit', customer, item, amount: Number(amount), time: 'Just now' }, ...current])
    setCustomer('')
    setItem('')
    setAmount('')
    setShowForm(false)
  }

  const startRecording = () => {
    setIsRecording(true)
    window.setTimeout(() => setIsRecording(false), 2200)
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark"><span>VC</span><strong>VoiceCredit</strong></div>
        <nav className="nav-list" aria-label="Primary navigation">
          <a className="nav-item active" href="#overview"><span className="nav-icon">◈</span> Overview</a>
          <a className="nav-item" href="#transactions"><span className="nav-icon">▤</span> Transactions</a>
          <a className="nav-item" href="#customers"><span className="nav-icon">◎</span> Customers</a>
          <a className="nav-item" href="#reports"><span className="nav-icon">▥</span> Reports</a>
        </nav>
        <div className="sidebar-foot">
          <div className="offline-status"><span className="status-dot" /> Offline ready</div>
          <div className="profile"><div className="avatar">AO</div><div><strong>Adetola</strong><small>Personal account</small></div><span className="more">•••</span></div>
        </div>
      </aside>

      <section className="content" id="overview">
        <header className="topbar"><div><p className="eyebrow">Tuesday, 06 August 2024</p><h1>Good morning, Adetola <span>✦</span></h1></div><button className="icon-button" aria-label="Notifications">♧<i /></button></header>

        <div className="hero-row">
          <section className="welcome-panel">
            <div><span className="section-label">Your day at a glance</span><h2>Keep business moving,<br /><em>just say it.</em></h2><p>Record a sale or payment in seconds. Your ledger stays with you, even offline.</p></div>
            <div className="voice-area"><button className={`voice-button ${isRecording ? 'recording' : ''}`} onClick={startRecording} aria-label="Record a voice transaction"><span className="mic-glyph">⌕</span></button><span>{isRecording ? 'Listening...' : 'Tap to record'}</span><small>Try: “Maya bought rice for 18,500 naira”</small></div>
          </section>
          <section className="today-card"><div className="card-head"><span className="section-label">Today</span><span className="trend">↑ 12.5%</span></div><strong className="today-total">{formatMoney(summary.credit)}</strong><p>in credit sales</p><div className="sparkline"><span /><span /><span /><span /><span /><span /><span /></div><div className="card-foot"><span>4 transactions</span><span>vs. yesterday</span></div></section>
        </div>

        <section className="stats-grid"><div className="stat-card"><span className="stat-icon green">↗</span><div><small>Collected this month</small><strong>{formatMoney(summary.payments)}</strong><span className="positive">↑ 8.2% <small>vs last month</small></span></div></div><div className="stat-card"><span className="stat-icon coral">◌</span><div><small>Outstanding credit</small><strong>{formatMoney(summary.outstanding)}</strong><span className="muted">from 12 customers</span></div></div><div className="stat-card"><span className="stat-icon yellow">♧</span><div><small>Active customers</small><strong>28</strong><span className="positive">↑ 3 new <small>this month</small></span></div></div></section>

        <section className="transactions-section" id="transactions"><div className="section-heading"><div><span className="section-label">Ledger</span><h2>Recent transactions</h2></div><div className="heading-actions"><button className="text-button">View all <span>→</span></button><button className="add-button" onClick={() => setShowForm((open) => !open)}>+ Add manually</button></div></div>
          {showForm && <form className="transaction-form" onSubmit={addTransaction}><input placeholder="Customer name" value={customer} onChange={(event) => setCustomer(event.target.value)} /><input placeholder="What was sold?" value={item} onChange={(event) => setItem(event.target.value)} /><input placeholder="Amount" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} /><button type="submit">Save credit</button></form>}
          <div className="table-wrap"><div className="table-header"><span>Customer</span><span>Details</span><span>Amount</span><span>Time</span><span /></div>{transactions.map((transaction) => <div className="transaction-row" key={transaction.id}><div className="customer-cell"><div className={`customer-avatar ${transaction.type}`}>{transaction.customer.split(' ').map((name) => name[0]).join('')}</div><strong>{transaction.customer}</strong></div><span className="details-cell"><i className={transaction.type} />{transaction.item}</span><strong className={transaction.type === 'payment' ? 'amount payment' : 'amount'}>{transaction.type === 'payment' ? '+' : ''}{formatMoney(transaction.amount)}</strong><span className="time-cell">{transaction.time}</span><button className="row-menu" aria-label={`More actions for ${transaction.customer}`}>•••</button></div>)}</div>
        </section>
        <footer><span><span className="status-dot" /> All changes saved locally</span><span>VoiceCredit v0.1 · Your data stays yours</span></footer>
      </section>
    </main>
  )
}

export default App
