import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const username =
  process.env.GITHUB_REPOSITORY_OWNER ||
  process.env.GITHUB_ACTOR ||
  "jameszu";
const token = process.env.GITHUB_TOKEN || "";
const output = process.argv[2] || "metrics/commit-hours.svg";
const timeZone = process.env.COMMIT_HOUR_TIMEZONE || "Pacific/Auckland";

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "jameszu-profile-readme",
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

async function fetchEvents() {
  const events = [];

  for (let page = 1; page <= 3; page += 1) {
    const url = `https://api.github.com/users/${username}/events/public?per_page=100&page=${page}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`GitHub events request failed: ${response.status} ${response.statusText}`);
    }

    const pageEvents = await response.json();

    if (!Array.isArray(pageEvents) || pageEvents.length === 0) {
      break;
    }

    events.push(...pageEvents);
  }

  return events;
}

async function fetchRepositories() {
  const repositories = [];

  for (let page = 1; page <= 2; page += 1) {
    const url = `https://api.github.com/users/${username}/repos?type=owner&sort=pushed&per_page=100&page=${page}`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`GitHub repositories request failed: ${response.status} ${response.statusText}`);
    }

    const pageRepositories = await response.json();

    if (!Array.isArray(pageRepositories) || pageRepositories.length === 0) {
      break;
    }

    repositories.push(...pageRepositories.filter((repository) => !repository.fork));
  }

  return repositories;
}

async function fetchRepositoryCommits(repository) {
  const url = `https://api.github.com/repos/${repository.full_name}/commits?author=${username}&per_page=100`;
  const response = await fetch(url, { headers });

  if (response.status === 409) {
    return [];
  }

  if (!response.ok) {
    throw new Error(`GitHub commits request failed for ${repository.full_name}: ${response.status} ${response.statusText}`);
  }

  const commits = await response.json();
  return Array.isArray(commits) ? commits : [];
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

function renderSvg(hours, totalCommits, sampleCount, sampleLabel) {
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
    .map((entry) => `${entry.hour}:00`);
  const peakLabel =
    peakHours.length > 0
      ? `most active: ${peakHours.join("-")} | ${max} commits`
      : "most active: no public commits";

  const bars = hours
    .map((count, hour) => {
      const barHeight = Math.max(2, Math.round((count / max) * chartHeight));
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

  const subtitle =
    totalCommits > 0
      ? `${totalCommits} commits from ${sampleCount} ${sampleLabel}`
      : "No public commits found";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Commit hours for ${escapeXml(username)}</title>
  <desc id="desc">${escapeXml(subtitle)}</desc>
  <style>
    text { font-family: Segoe UI, Ubuntu, Helvetica Neue, Arial, sans-serif; }
    .title { fill: #0969da; font-size: 22px; font-weight: 600; }
    .subtitle { fill: #57606a; font-size: 13px; }
    .axis { fill: #57606a; font-size: 11px; }
    .label { fill: #24292f; font-size: 12px; font-weight: 600; }
  </style>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="6" fill="#ffffff" stroke="#d0d7de"/>
  <text x="30" y="38" class="title">Commit Hours</text>
  <text x="30" y="58" class="subtitle">${escapeXml(subtitle)} · ${escapeXml(timeZone)}</text>
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

const events = await fetchEvents();
const pushEvents = events.filter((event) => event.type === "PushEvent");
const hours = Array.from({ length: 24 }, () => 0);
let totalCommits = 0;
let sampleCount = pushEvents.length;
let sampleLabel = "recent public push events";

for (const event of pushEvents) {
  const commitCount = event.payload?.commits?.length ?? 1;
  const hour = hourInTimeZone(event.created_at);
  hours[hour] += commitCount;
  totalCommits += commitCount;
}

if (totalCommits === 0) {
  const repositories = await fetchRepositories();
  let repositoriesWithCommits = 0;

  for (const repository of repositories) {
    const commits = await fetchRepositoryCommits(repository);

    if (commits.length > 0) {
      repositoriesWithCommits += 1;
    }

    for (const commit of commits) {
      const isoDate = commit.commit?.author?.date || commit.commit?.committer?.date;

      if (!isoDate) {
        continue;
      }

      const hour = hourInTimeZone(isoDate);
      hours[hour] += 1;
      totalCommits += 1;
    }
  }

  sampleCount = repositoriesWithCommits;
  sampleLabel = "public repositories";
}

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, renderSvg(hours, totalCommits, sampleCount, sampleLabel), "utf8");
