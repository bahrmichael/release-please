// Copyright 2021 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {ManifestPlugin} from '../plugin';
import {
  CandidateReleasePullRequest,
  RepositoryConfig,
  MANIFEST_PULL_REQUEST_TITLE_PATTERN,
  ROOT_PROJECT_PATH,
  MANIFEST_BRANCH_NAME_PATTERN,
} from '../manifest';
import {PullRequestTitle} from '../util/pull-request-title';
import {PullRequestBody, ReleaseData} from '../util/pull-request-body';
import {BranchName} from '../util/branch-name';
import {Update} from '../update';
import {mergeUpdates} from '../updaters/composite';
import {GitHub} from '../github';

/**
 * This plugin merges multiple pull requests into a single
 * release pull request.
 *
 * Release notes are broken up using `<summary>`/`<details>` blocks.
 */
export class Merge extends ManifestPlugin {
  private sourceBranch: BranchName;
  private pullRequestTitlePattern?: string;
  private pullRequestHeader?: string;

  constructor(
    github: GitHub,
    targetBranch: string,
    repositoryConfig: RepositoryConfig,
    sourceBranch: BranchName | string = MANIFEST_BRANCH_NAME_PATTERN,
    pullRequestTitlePattern?: string,
    pullRequestHeader?: string
  ) {
    super(github, targetBranch, repositoryConfig);
    this.pullRequestTitlePattern =
      pullRequestTitlePattern || MANIFEST_PULL_REQUEST_TITLE_PATTERN;
    this.pullRequestHeader = pullRequestHeader;
    this.sourceBranch =
      sourceBranch instanceof BranchName
        ? sourceBranch
        : BranchName.ofTargetBranch(
            sourceBranch.replace('${branch}', targetBranch)
          );
  }

  async run(
    candidates: CandidateReleasePullRequest[]
  ): Promise<CandidateReleasePullRequest[]> {
    if (candidates.length < 1) {
      return candidates;
    }
    this.logger.info(`Merging ${candidates.length} pull requests`);

    const [inScopeCandidates, outOfScopeCandidates] = candidates.reduce<
      Array<Array<CandidateReleasePullRequest>>
    >(
      (collection, candidate) => {
        if (candidate.config.separatePullRequests) {
          collection[1].push(candidate);
        } else {
          collection[0].push(candidate);
        }
        return collection;
      },
      [[], []]
    );

    const releaseData: ReleaseData[] = [];
    const labels = new Set<string>();
    let rawUpdates: Update[] = [];
    let rootRelease: CandidateReleasePullRequest | null = null;
    for (const candidate of inScopeCandidates) {
      const pullRequest = candidate.pullRequest;
      rawUpdates = rawUpdates.concat(...pullRequest.updates);
      for (const label of pullRequest.labels) {
        labels.add(label);
      }
      releaseData.push(...pullRequest.body.releaseData);
      if (candidate.path === '.') {
        rootRelease = candidate;
      }
    }
    const updates = mergeUpdates(rawUpdates);

    const pullRequest = {
      title: PullRequestTitle.ofComponentTargetBranchVersion(
        rootRelease?.pullRequest.title.component,
        this.targetBranch,
        rootRelease?.pullRequest.title.version,
        this.pullRequestTitlePattern
      ),
      body: new PullRequestBody(releaseData, {
        useComponents: true,
        header: this.pullRequestHeader,
      }),
      updates,
      labels: Array.from(labels),
      headRefName: this.sourceBranch.toString(),
      draft: !candidates.some(candidate => !candidate.pullRequest.draft),
    };

    const releaseTypes = new Set(
      candidates.map(candidate => candidate.config.releaseType)
    );
    const releaseType =
      releaseTypes.size === 1 ? releaseTypes.values().next().value : 'simple';
    return [
      {
        path: ROOT_PROJECT_PATH,
        pullRequest,
        config: {
          releaseType,
        },
      },
      ...outOfScopeCandidates,
    ];
  }
}
