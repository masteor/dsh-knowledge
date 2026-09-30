import { generate } from './generator.js'
import { fail } from './domain.js'
import { Scheduler } from './scheduler.js'

export class Worker {
  constructor(store, llm, render = generate, onError = () => {}) { this.store = store; this.llm = llm; this.render = render; this.closed = false; this.onError = onError; this.scheduler = new Scheduler(store) }
  start() { this.timer = setInterval(() => this.tick(), 1500); this.timer.unref?.(); this.tick() }
  async tick() {
    if (this.running || this.closed) return
    this.running = this.run().catch(() => this.onError()).finally(() => { this.running = null })
    return this.running
  }
  async run() {
    if (this.isEnabled && !this.isEnabled()) return
    this.scheduler.tick()
    const job = this.store.next()
    if (!job) return
    const payload = JSON.parse(job.body), attempts = job.attempts + 1
    this.active = job.id; this.controller = new AbortController()
    const timeout = setTimeout(() => this.controller?.abort(new Error('Истекло время обработки')), 180000)
    this.store.status(job.id, 'running', payload, attempts)
    try {
      const result = await this.render(this.llm, payload, this.controller.signal)
      if (this.closed || this.store.job(job.id).status === 'cancelled') return
      const current = new Set(this.store.records(job.day).map(r => r.id))
      if (payload.records.some(r => !current.has(r.id))) throw fail('Во время обработки источник был исключён — запустите обработку заново', 409)
      this.store.save(job.day, result, payload.revision, payload.records.map(r => r.id), false)
      this.store.status(job.id, 'done', { ...payload, error: '' }, attempts)
    } catch (e) {
      if (this.closed) this.store.status(job.id, 'queued', payload, job.attempts)
      else if (this.store.job(job.id).status !== 'cancelled') {
        const retry = attempts < 3 && e.status !== 409
        this.store.status(job.id, retry ? 'queued' : 'failed', { ...payload, error: e.status === 409 ? e.message : 'Обработка моделью не удалась или истёк тайм-аут. Проверьте подключение модели сессии и повторите попытку.' }, attempts, Date.now() + attempts * 10000)
      }
    } finally { clearTimeout(timeout); this.active = null; this.controller = null }
  }
  cancel(id) {
    const job = this.store.job(id)
    if (!job || !['queued', 'running'].includes(job.status)) throw fail('Задача завершена')
    this.store.status(id, 'cancelled', JSON.parse(job.body), job.attempts)
    if (this.active === id) this.controller.abort(new Error('Отменено'))
  }
  async close() { this.closed = true; clearInterval(this.timer); this.controller?.abort(new Error('Служба остановлена')); await this.running }
}
