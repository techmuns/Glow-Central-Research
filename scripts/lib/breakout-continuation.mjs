import {marketWindow} from '../../public/js/data/breakout-live-shared.js';

// Cron remains the recovery path. An acknowledged market run also hands off to
// the next ordinary runner, so a delayed cron event cannot leave hours of gaps.
// The workflow's concurrency group permits only one collector at a time.
export async function continueBreakoutCapture({acknowledged=false,now=Date.now(),env=process.env,fetcher=fetch}={}) {
 if(!acknowledged||!marketWindow(now).collect)return false;
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_REPOSITORY!=='techmuns/Glow-Central-Research')throw Error('Invalid quote continuation context');
 // The interactive dispatch helper suppresses a request while this very run is
 // still in progress. This handoff deliberately queues its successor instead.
 if(!env.GITHUB_TOKEN||!/^\d+$/.test(env.GITHUB_RUN_ID||''))throw Error('Invalid quote continuation identity');
 const response=await fetcher('https://api.github.com/repos/techmuns/Glow-Central-Research/actions/workflows/breakouts-refresh.yml/dispatches',{method:'POST',headers:{authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','content-type':'application/json','user-agent':'ResearchQuoteContinuation'},body:JSON.stringify({ref:'main',inputs:{source:'market-window-continuation'}}),redirect:'error',signal:AbortSignal.timeout(20000)});
 await response.body?.cancel();
 if(response.status!==204)throw Error('Quote continuation was not acknowledged');
 return true;
}
