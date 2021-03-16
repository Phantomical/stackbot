import { Probot, Context } from "probot";
import { WebhookEvent } from "probot/node_modules/@octokit/webhooks/dist-types/types";
import { EventPayloads } from "probot/node_modules/@octokit/webhooks/dist-types/generated/event-payloads"

import utils from './utils';

// const BOT_NAME = "phantomical-pr-stacker";
const CHECK_NAME = "stacked-dependencies";

type PRContext = WebhookEvent<EventPayloads.WebhookPayloadPullRequest>
  & Omit<Context<any>, keyof WebhookEvent<any>>;

async function updatePullRequestChecks(context: PRContext) {
  let checkRuns = await context.octokit.checks.listForRef(context.repo({
    ref: context.payload.pull_request.head.sha,
    check_name: CHECK_NAME,
    filter: "latest"
  }));

  let run = checkRuns.data.check_runs.find((run) => {
    return run.pull_requests.some((pr) => {
      return pr.id == context.payload.pull_request.id;
    });
  });

  let basePullId = utils.extractBasePRId(context.payload.pull_request.body);

  let payload;
  let hasNoDeps = basePullId == null
    || (/stackbot\/pr-[0-9]+/.exec(context.payload.pull_request.base.ref) == null);

  if (hasNoDeps) {
    payload = {
      status: "completed",
      conclusion: "success",
      output: {
        title: "This PR has no dependencies!",
        summary: "This PR has no dependencies!"
      }
    };
  } else {
    payload = {
      status: "completed",
      conclusion: "failure",
      output: {
        title: `Waiting for #${basePullId} to be merged or closed`,
        summary: `Waiting for #${basePullId} to be merged or closed`
      }
    };
  }

  if (typeof run === "undefined") {
    await context.octokit.checks.create(context.repo({
      name: CHECK_NAME,
      head_sha: context.payload.pull_request.head.sha,
      ...payload
    }));
  } else {
    await context.octokit.checks.update(context.repo({
      name: CHECK_NAME,
      check_run_id: run.id,
      ...payload
    }));
  }

  let labels = context.payload.pull_request.labels;
  let hasLabel = labels.some((label) => {
    return label.name == "stacked";
  });

  // TODO: Create the label if it doesn't exist
  await utils.tryRun(context, async () => {
    if (!hasNoDeps && !hasLabel) {
      await context.octokit.issues.addLabels(context.issue({
        labels: ["stacked"]
      }));
    } else if (hasNoDeps && hasLabel) {
      await context.octokit.issues.removeLabel(context.issue({
        name: "stacked"
      }));
    }
  });
}
async function updateFollowingBranchRef(context: PRContext) {
  try {
    const branchName = utils.branchNameForPR(context.payload.number);
    await context.octokit.git.updateRef(context.repo({
      ref: `heads/${branchName}`,
      sha: context.payload.pull_request.head.sha,
      force: true
    }));
  } catch (err) { }
}
async function deleteFollowingBranchRef(context: PRContext) {
  const branchName = utils.branchNameForPR(context.payload.number);
  const { repo, owner } = context.repo();

  let results;
  let page = 1;
  do {
    results = await context.octokit.search.issuesAndPullRequests({
      q: `is:pull-request state:open repo:${owner}/${repo} base:${branchName}`,
      per_page: 100,
      page
    });

    // Update all dependent PRs
    for (let i = 0; i < results.data.items.length; ++i) {
      const item = results.data.items[i];

      await utils.tryRun(context, async () => {
        let pr = await context.octokit.pulls.get(context.pullRequest({
          pull_number: item.number
        }));

        await context.octokit.pulls.update(context.repo({
          pull_number: pr.data.number,
          base: context.payload.pull_request.base.ref
        }));
      });
    }

    page += 1;
  } while (results.data.items.length == 100);

  await utils.tryRun(context, async () => {
    await context.octokit.repos.deleteBranchProtection(context.repo({
      branch: branchName
    }));
  });

  await utils.tryRun(context, async () => {
    await context.octokit.git.deleteRef(context.repo({
      ref: `heads/${branchName}`
    }));
  });
}
async function createFollowingBranchRefForBase(context: PRContext) {
  let basePullId = utils.extractBasePRId(context.payload.pull_request.body);

  // Do nothing if the PR comment doesn't contain a pull request marker.
  if (basePullId == null)
    return;

  // If the base PR is the current PR then don't do anything
  if (basePullId == context.payload.number)
    return;

  const branchName = utils.branchNameForPR(basePullId);

  // PR is already stacked, do nothing
  if (context.payload.pull_request.base.ref == branchName)
    return;

  let basePR = await utils.tryRun(context, () => {
    return context.octokit.pulls.get(context.pullRequest({
      pull_number: basePullId
    }));
  });

  if (basePR == null || basePR.data.state == "closed")
    return;

  let branchCreated = await utils.createFollowerBranch(
    context.octokit, basePullId, basePR.data.head.sha, context.pullRequest());

  await context.octokit.pulls.update(context.pullRequest({
    base: branchName
  }));

  if (branchCreated) {
    await context.octokit.repos.updateBranchProtection(context.repo({
      branch: branchName,
      required_status_checks: {
        strict: false,
        contexts: [CHECK_NAME]
      },
      enforce_admins: true,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: true,
      // allow_deletions: false
    }));
  }
}
async function unstackPullRequestIfCommentRemoved(context: PRContext) {
  let payload: any = context.payload;

  if (typeof (payload.changes) == "undefined"
    || typeof (payload.changes.body) == "undefined"
    || typeof (payload.changes.body.from) == "undefined")
    return;

  let currentBase = utils.extractBasePRId(context.payload.pull_request.body);
  let prevBase = utils.extractBasePRId(payload.changes.body.from);

  if (currentBase === context.payload.number)
    currentBase = null;
  if (prevBase === context.payload.number)
    prevBase = null;

  if (!(currentBase == null && prevBase != null))
    return;

  await context.octokit.pulls.update(context.pullRequest({
    base: "master"
  }));
}

export = (app: Probot) => {
  app.onAny(async (context) => {
    app.log.info(`action: ${context.name}.${context.payload.action}`);
  });

  app.on("pull_request.opened", async (context) => {
    await utils.tryRun(context, async () => {
      await createFollowingBranchRefForBase(context);
    });

    await utils.tryRun(context, async () => {
      await updatePullRequestChecks(context);
    });
  });
  app.on("pull_request.edited", async (context) => {
    await utils.tryRun(context, async () => {
      await createFollowingBranchRefForBase(context);
    });

    await utils.tryRun(context, async () => {
      await updatePullRequestChecks(context);
    });

    await utils.tryRun(context, async () => {
      await unstackPullRequestIfCommentRemoved(context);
    });
  });

  app.on("pull_request.merged", async (context) => {
    await utils.tryRun(context, async () => {
      await deleteFollowingBranchRef(context);
    });
  });
  app.on("pull_request.closed", async (context) => {
    await utils.tryRun(context, async () => {
      await deleteFollowingBranchRef(context);
    });
  });

  app.on("pull_request.synchronize", async (context) => {
    await utils.tryRun(context, async () => {
      await updatePullRequestChecks(context);
    });

    await utils.tryRun(context, async () => {
      await updateFollowingBranchRef(context);
    });
  });
};
