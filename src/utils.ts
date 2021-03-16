import { ProbotOctokit, Context } from "probot";

type Octokit = InstanceType<typeof ProbotOctokit>;
type ReqContext = { owner: string, repo: string };

function branchNameForPR(prId: number): string {
  return `stackbot/pr-${prId}`;
}

function extractBasePRId(body: string): number | null {
  const lines = body.split(/\r?\n/g);
  for (let i = 0; i < lines.length; ++i) {
    let match = /\/stack\s+#([0-9]+)/.exec(lines[i].trim());
    if (match == null)
      continue;

    return parseInt(match[1]);
  }

  return null;
}

async function branchExists(
  octokit: Octokit,
  pull_number: number,
  context: ReqContext
): Promise<boolean> {
  try {
    await octokit.git.getRef({
      ref: `heads/${branchNameForPR(pull_number)}`,
      ...context
    });
    return true;
  } catch (err) {
    return false;
  }
}

// Create a branch to follow the provided pull request
async function createFollowerBranch(
  octokit: Octokit,
  pull_number: number,
  pull_sha: string,
  context: ReqContext) {
  const branchName = branchNameForPR(pull_number);

  try {
    await octokit.git.createRef({
      ref: `refs/heads/${branchName}`,
      sha: pull_sha,
      ...context
    });

    return true;
  } catch (err) { 
    return false;
  }
}

async function tryRun<R>(context: Context, func: () => Promise<R>): Promise<R | null> {
  try {
    return await func();
  } catch(err) {
    context.log.error(`Error while processing event `
      + `${context.name}.${context.payload.action}`
      + `for PR ${context.payload.number ? context.payload.number : "null"}`
    )
    context.log.error(err);
    return null;
  }
}

export = {
  tryRun,
  branchNameForPR,
  branchExists,
  createFollowerBranch,
  extractBasePRId
}
