import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const username =
  process.env.GITHUB_REPOSITORY_OWNER ||
  process.env.GITHUB_ACTOR ||
  "jameszu";
const token = process.env.GITHUB_TOKEN || "";
const timeZone = process.env.COMMIT_HOUR_TIMEZONE || "Pacific/Auckland";
const periodYears = Number(process.env.COMMIT_HOUR_PERIOD_YEARS || 10);
const requirePrivateRepositories =
  process.env.REQUIRE_PRIVATE_REPOSITORIES === "true";
const outputDirectory = process.argv[2] || ".";
const now = new Date();
const periodStart = new Date(now);
periodStart.setUTCFullYear(periodStart.getUTCFullYear() - periodYears);

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "jameszu-profile-readme",
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

const languageColors = {
  "C#": "#178600",
  "C++": "#f34b7d",
  CSS: "#563d7c",
  Go: "#00ADD8",
  HTML: "#e34c26",
  Java: "#b07219",
  JavaScript: "#f1e05a",
  Kotlin: "#A97BFF",
  PHP: "#4F5D95",
  PowerShell: "#012456",
  Python: "#3572A5",
  Ruby: "#701516",
  Rust: "#dea584",
  Shell: "#89e051",
  Swift: "#F05138",
  TypeScript: "#3178c6",
};

async function requestJson(url, options = {}) {
  const response = await fetch(url, { headers });

  if (options.allowEmptyRepository && response.status === 409) {
    return { data: [], response };
  }

  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText} (${url})`);
  }

  return { data: await response.json(), response };
}

async function fetchAuthenticatedOwner() {
  if (!token) {
    return null;
  }

  try {
    const { data } = await requestJson("https://api.github.com/user");
    return data?.login?.toLowerCase() === username.toLowerCase() ? data : null;
  } catch {
    return null;
  }
}

async function fetchRepositories() {
  const authenticatedOwner = await fetchAuthenticatedOwner();
  const repositories = [];

  for (let page = 1; ; page += 1) {
    const url = authenticatedOwner
      ? `https://api.github.com/user/repos?visibility=all&affiliation=owner&sort=full_name&per_page=100&page=${page}`
      : `https://api.github.com/users/${username}/repos?type=owner&sort=full_name&per_page=100&page=${page}`;
    const { data } = await requestJson(url);

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    repositories.push(
      ...data.filter(
        (repository) =>
          !repository.fork &&
          repository.owner?.login?.toLowerCase() === username.toLowerCase(),
      ),
    );

    if (data.length < 100) {
      break;
    }
  }

  return {
    repositories,
    includesPrivate: Boolean(authenticatedOwner),
  };
}

async function fetchAllCommits(repository) {
  const commits = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${repository.full_name}/commits`,
    );
    url.searchParams.set("author", username);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const { data } = await requestJson(url, { allowEmptyRepository: true });

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    commits.push(...data);

    if (data.length < 100) {
      break;
    }
  }

  return commits;
}

function hourInTimeZone(isoDate) {
  const parts = new Intl.DateTimeFormat("en-NZ", {
    hour: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(new Date(isoDate));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  return hour === 24 ? 0 : hour;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function topEntries(values, limit = 5) {
  return [...values.entries()]
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

function colorForLanguage(language, index) {
  const fallback = ["#0969da", "#40c463", "#bf8700", "#8250df", "#cf222e"];
  return languageColors[language] || fallback[index % fallback.length];
}

function renderLanguageCard(title, entries, total, subtitle, valueLabel) {
  const width = 340;
  const height = 200;
  const labelX = 24;
  const barX = 118;
  const valueX = 316;
  const chartY = 76;
  const chartWidth = 150;
  const barHeight = 10;
  const rowGap = 24;
  const max = Math.max(...entries.map(([, value]) => value), 1);

  const rows = entries
    .map(([language, value], index) => {
      const y = chartY + index * rowGap;
      const barWidth = Math.max(3, Math.round((value / max) * chartWidth));
      const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
      const color = colorForLanguage(language, index);
      return `<g>
    <text x="${labelX}" y="${y + 4}" class="language">${escapeXml(language)}</text>
    <rect x="${barX}" y="${y - 6}" width="${chartWidth}" height="${barHeight}" rx="5" fill="#eff2f5"/>
    <rect x="${barX}" y="${y - 6}" width="${barWidth}" height="${barHeight}" rx="5" fill="${color}"><title>${escapeXml(language)}: ${value} ${escapeXml(valueLabel)}</title></rect>
    <text x="${valueX}" y="${y + 4}" text-anchor="end" class="value">${percentage}%</text>
  </g>`;
    })
    .join("\n  ");

  const emptyState =
    entries.length === 0
      ? '<text x="170" y="120" text-anchor="middle" class="subtitle">No language data found</text>'
      : rows;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <style>
    text { font-family: Segoe UI, Ubuntu, Helvetica Neue, Arial, sans-serif; }
    .title { fill: #0969da; font-size: 20px; font-weight: 600; }
    .subtitle { fill: #57606a; font-size: 10px; }
    .language { fill: #24292f; font-size: 12px; font-weight: 600; }
    .value { fill: #57606a; font-size: 11px; }
  </style>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="6" fill="#ffffff" stroke="#d0d7de"/>
  <text x="24" y="34" class="title">${escapeXml(title)}</text>
  <text x="24" y="53" class="subtitle">${escapeXml(subtitle)}</text>
  ${emptyState}
</svg>
`;
}

function renderCommitHours(hours, totalCommits, repositoryCount, scopeLabel) {
  const width = 680;
  const height = 250;
  const chartX = 36;
  const chartY = 72;
  const chartWidth = 608;
  const chartHeight = 112;
  const gap = 4;
  const barWidth = (chartWidth - gap * 23) / 24;
  const max = Math.max(...hours, 1);
  const labels = new Set([0, 6, 12, 18, 23]);
  const peakHours = hours
    .map((count, hour) => ({ count, hour }))
    .filter((entry) => entry.count === max && entry.count > 0)
    .map((entry) => `${String(entry.hour).padStart(2, "0")}:00`);
  const peakLabel =
    peakHours.length > 0
      ? `most active: ${peakHours.join("-")} | ${max} commits`
      : "most active: no commits";

  const bars = hours
    .map((count, hour) => {
      const barHeight = count > 0
        ? Math.max(2, Math.round((count / max) * chartHeight))
        : 0;
      const x = chartX + hour * (barWidth + gap);
      const y = chartY + chartHeight - barHeight;
      const fill = count === max && count > 0 ? "#0969da" : "#40c463";
      return `<rect x="${x.toFixed(1)}" y="${y}" width="${barWidth.toFixed(1)}" height="${barHeight}" rx="3" fill="${fill}"><title>${hour}:00 - ${count} commits</title></rect>`;
    })
    .join("\n      ");

  const hourLabels = [...labels]
    .map((hour) => {
      const x = chartX + hour * (barWidth + gap) + barWidth / 2;
      return `<text x="${x.toFixed(1)}" y="206" text-anchor="middle" class="axis">${hour}</text>`;
    })
    .join("\n      ");

  const subtitle = `${formatDate(periodStart)} to ${formatDate(now)} | ${totalCommits} commits | ${repositoryCount} repos | ${scopeLabel} | ${timeZone}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <style>
    text { font-family: Segoe UI, Ubuntu, Helvetica Neue, Arial, sans-serif; }
    .title { fill: #0969da; font-size: 22px; font-weight: 600; }
    .subtitle { fill: #57606a; font-size: 12px; }
    .axis { fill: #57606a; font-size: 11px; }
    .label { fill: #24292f; font-size: 12px; font-weight: 600; }
  </style>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="6" fill="#ffffff" stroke="#d0d7de"/>
  <text x="30" y="38" class="title">Commit Hours - Last ${periodYears} Years</text>
  <text x="30" y="58" class="subtitle">${escapeXml(subtitle)}</text>
  <line x1="${chartX}" y1="${chartY + chartHeight}" x2="${chartX + chartWidth}" y2="${chartY + chartHeight}" stroke="#d0d7de"/>
  <g>
      ${bars}
  </g>
  <g>
      ${hourLabels}
  </g>
  <text x="${chartX}" y="226" class="axis">hour of day</text>
  <text x="${width - 36}" y="226" text-anchor="end" class="label">${escapeXml(peakLabel)}</text>
</svg>
`;
}

const { repositories, includesPrivate } = await fetchRepositories();

if (requirePrivateRepositories && !includesPrivate) {
  throw new Error(
    "Private repository access is required. Configure SUMMARY_CARDS_TOKEN with read access to all repositories.",
  );
}

const repoLanguages = new Map();
const commitLanguages = new Map();
const commitHours = Array.from({ length: 24 }, () => 0);
let allCommitCount = 0;
let periodCommitCount = 0;
let repositoriesWithCommits = 0;

for (const repository of repositories) {
  const language = repository.language || "Other";
  repoLanguages.set(language, (repoLanguages.get(language) || 0) + 1);

  const commits = await fetchAllCommits(repository);

  if (commits.length > 0) {
    repositoriesWithCommits += 1;
  }

  commitLanguages.set(
    language,
    (commitLanguages.get(language) || 0) + commits.length,
  );
  allCommitCount += commits.length;

  for (const commit of commits) {
    const isoDate = commit.commit?.author?.date || commit.commit?.committer?.date;

    if (!isoDate || new Date(isoDate) < periodStart) {
      continue;
    }

    commitHours[hourInTimeZone(isoDate)] += 1;
    periodCommitCount += 1;
  }
}

const scopeLabel = includesPrivate ? "public + private" : "public only";
const repoEntries = topEntries(repoLanguages);
const commitEntries = topEntries(commitLanguages);
const repoSubtitle = `${repositories.length} non-fork repos | ${scopeLabel}`;
const commitSubtitle = `${allCommitCount} commits | ${repositoriesWithCommits} repos | all history | ${scopeLabel}`;

const outputs = [
  [
    "profile-summary-card-output/github/1-repos-per-language.svg",
    renderLanguageCard(
      "Top Languages by Repo",
      repoEntries,
      repositories.length,
      repoSubtitle,
      "repositories",
    ),
  ],
  [
    "profile-summary-card-output/github/2-most-commit-language.svg",
    renderLanguageCard(
      "Top Languages by Commit",
      commitEntries,
      allCommitCount,
      commitSubtitle,
      "commits",
    ),
  ],
  [
    "metrics/commit-hours.svg",
    renderCommitHours(
      commitHours,
      periodCommitCount,
      repositoriesWithCommits,
      scopeLabel,
    ),
  ],
];

for (const [relativePath, content] of outputs) {
  const outputPath = path.join(outputDirectory, relativePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
}
