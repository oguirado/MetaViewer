// Observed output is not authentication proof. Require a known input prompt,
// reject visible authentication/trust questions, and never answer those questions.
export const AGENT_PROFILE_IDS=Object.freeze(['agent-codex','agent-gemini','agent-opencode','agent-muse']);
export const AGENT_START_TIMEOUT_MS=15000;
/** @param {string} text */
export function plainAgentOutput(text) {
  return text.replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
}
/** @param {string} profile @param {string} text */
export function agentPromptState(profile,text) {
  const plain=plainAgentOutput(text);
  if(/sign[ -]?in|log[ -]?in|authenticate|authentication required|enter.{0,20}api[ _-]?key|choose.{0,20}(?:account|auth)|trust (?:this|the) (?:folder|directory|workspace)|do you trust|trust the contents|select.{0,20}(?:login|auth)|approve.{0,20}(?:workspace|directory)|(?:continue|proceed).{0,10}\(y\/n\)/i.test(plain)) return 'authentication';
  if(profile==='agent-codex' && (/OpenAI Codex|Ask Codex to do anything/i.test(plain)) && /[›❯]/.test(plain)) return 'ready';
  if(profile==='agent-muse' && /Muse\s*Code/i.test(plain) && /muse-spark-1\.3/i.test(plain) && /❯/.test(plain)) return 'ready';
  if(profile==='agent-gemini' && /Type your message/i.test(plain)) return 'ready';
  if(profile==='agent-opencode' && /Ask anything/i.test(plain)) return 'ready';
  return 'waiting';
}
