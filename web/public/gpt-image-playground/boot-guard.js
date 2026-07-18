(() => {
  const MAX_AGENT_CONVERSATIONS = 24
  const originalGetAll = IDBObjectStore.prototype.getAll

  IDBObjectStore.prototype.getAll = function (...args) {
    if (this.name !== 'agentConversations') return originalGetAll.apply(this, args)
    const query = args[0]
    const count = typeof args[1] === 'number' ? Math.min(args[1], MAX_AGENT_CONVERSATIONS) : MAX_AGENT_CONVERSATIONS
    return originalGetAll.call(this, query, count)
  }
})()
