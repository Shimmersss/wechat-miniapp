const auth = require('./auth');
const { isAgent } = require('./permission');
const { ROUTES } = require('./router');

async function openAgentCenter(page, refreshStatus) {
  if (page.data.checkingAgent) return;
  page.setData({ checkingAgent: true });
  try {
    const user = await auth.refreshMe();
    if (isAgent(user)) return page.$go(ROUTES.AGENT_CENTER);
    page.$toast(user?.agentStatus === 'disabled' ? '代理资格已停用，请联系门店' : '代理资格尚未开通');
    await refreshStatus();
  } catch (error) {
    page.$toast(error.message || '无法确认代理身份，请重试');
  } finally {
    page.setData({ checkingAgent: false });
  }
}

module.exports = { openAgentCenter };
