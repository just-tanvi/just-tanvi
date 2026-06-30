// generate.mjs
// Fetches a GitHub user's contribution calendar and renders an animated
// SVG where Mario runs across the grid, jumping onto "active" (green) cells
// and passing/falling under "inactive" (dark) ones.
//
// Usage:
//   node scripts/generate.mjs <github-username> [outfile]
//
// No GitHub token required — uses the public contributions API mirror
// (https://github-contributions-api.jogruber.de), the same data source
// many "contribution graph" tools use.

import fs from "fs";

const username = process.argv[2];
const outfile = process.argv[3] || "mario.svg";

if (!username) {
  console.error("Usage: node generate.mjs <github-username> [outfile]");
  process.exit(1);
}

const CELL = 12;        // cell size (matches GitHub's graph roughly)
const GAP = 3;          // gap between cells
const STEP = CELL + GAP;
const PADDING_TOP = 40; // room for Mario's jump arc above row 0
const PADDING_LEFT = 20;
const PADDING_BOTTOM = 15;

async function fetchContributions(user) {
  const url = `https://github-contributions-api.jogruber.de/v4/${user}?y=last`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch contributions for ${user}: ${res.status}`);
  }
  const data = await res.json();
  // data.contributions: [{ date, count, level }]
  return data.contributions;
}

// Reshape a flat list of days into GitHub's week-column grid (7 rows x N weeks),
// aligned so Sunday = row 0, same as the real graph.
function toWeekGrid(days) {
  const weeks = [];
  let currentWeek = new Array(7).fill(null);

  days.forEach((day) => {
    const date = new Date(day.date + "T00:00:00Z");
    const dow = date.getUTCDay(); // 0 = Sunday
    if (dow === 0 && currentWeek.some((d) => d !== null)) {
      weeks.push(currentWeek);
      currentWeek = new Array(7).fill(null);
    }
    currentWeek[dow] = day;
  });
  if (currentWeek.some((d) => d !== null)) weeks.push(currentWeek);
  return weeks;
}

function buildSvg(weeks, user) {
  const numWeeks = weeks.length;
  const width = PADDING_LEFT * 2 + numWeeks * STEP;
  
  // Dynamic theme colors depending on the output file name
  const isDark = outfile.includes("dark");
  const LEVEL_COLORS = isDark
    ? {
        0: "#161b22",
        1: "#0e4429",
        2: "#006d32",
        3: "#26a641",
        4: "#39d353",
      }
    : {
        0: "#ebedf0",
        1: "#9be9a8",
        2: "#40c463",
        3: "#30a14e",
        4: "#216e39",
      };

  const groundColor = isDark ? "#30363d" : "#e1e4e8";
  const cellStrokeColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(27,31,35,0.06)";
  const textColor = isDark ? "#8b949e" : "#57606a";
  const groundY = PADDING_TOP + 7 * STEP; // baseline Mario runs along when not jumping
  const height = groundY + PADDING_BOTTOM;
  const jumpHeight = 26;

  // Build the full 7-row contribution graph grid
  const cellRects = [];
  weeks.forEach((week, wi) => {
    const x = PADDING_LEFT + wi * STEP;
    week.forEach((day, di) => {
      if (!day) return; // skip padding days at the beginning/end of the year
      const level = day.level;
      const landable = level > 0;
      const strokeColor = landable
        ? (isDark ? "#2ea043" : "#40c463")
        : (isDark ? "#30363d" : "#e1e4e8");
      cellRects.push(`<rect x="${x}" y="${PADDING_TOP + di * STEP}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${LEVEL_COLORS[level]}" stroke="${strokeColor}" stroke-width="0.5">${day.date ? `<title>${day.date}: ${day.count} contributions</title>` : ""}</rect>`);
    });
  });

  const cellRectsStr = cellRects.join("\n    ");

  // Mario physics coordinates setup
  // We represent columns including virtual starting (off-screen left) and ending (off-screen right)
  const columns = [];
  
  // Mario offset so his feet are exactly on the line
  const MARIO_OFFSET_Y = 6;

  // Virtual column -1: starting off-screen left on the ground
  columns.push({
    left: -10,
    right: -10,
    y: groundY - MARIO_OFFSET_Y,
    isGround: true,
  });

  let lastRow = 'ground';
  for (let c = 0; c < numWeeks; c++) {
    const greenRows = [];
    const week = weeks[c];
    for (let r = 0; r < 7; r++) {
      const day = week[r];
      if (day && day.level > 0) {
        greenRows.push(r);
      }
    }

    const left = PADDING_LEFT + c * STEP;
    const right = left + CELL;

    if (greenRows.length > 0) {
      // Find the closest green row to Mario's current row
      let bestRow = greenRows[0];
      let minDiff = Math.abs(bestRow - (lastRow === 'ground' ? 7 : lastRow));
      for (let idx = 1; idx < greenRows.length; idx++) {
        const r = greenRows[idx];
        const diff = Math.abs(r - (lastRow === 'ground' ? 7 : lastRow));
        if (diff < minDiff) {
          minDiff = diff;
          bestRow = r;
        } else if (diff === minDiff) {
          // Tie-breaker: choose higher level contribution
          const dayR = week[r];
          const dayBest = week[bestRow];
          if (dayR && dayBest && dayR.level > dayBest.level) {
            bestRow = r;
          }
        }
      }
      lastRow = bestRow;
      const y = PADDING_TOP + bestRow * STEP - MARIO_OFFSET_Y;
      columns.push({ left, right, y, isGround: false });
    } else {
      lastRow = 'ground';
      const y = groundY - MARIO_OFFSET_Y;
      columns.push({ left, right, y, isGround: true });
    }
  }

  // Virtual column N: ending off-screen right on the ground
  columns.push({
    left: width + 10,
    right: width + 10,
    y: groundY - MARIO_OFFSET_Y,
    isGround: true,
  });

  // Identify candidate columns for shell hazards
  const candidateHazards = [];
  for (let c = 1; c < numWeeks - 1; c++) {
    if (columns[c].isGround && columns[c - 1].isGround && columns[c + 1].isGround) {
      candidateHazards.push(c);
    }
  }

  const hazardCols = [];
  if (candidateHazards.length > 0) {
    if (candidateHazards.length <= 4) {
      hazardCols.push(...candidateHazards);
    } else {
      // Pick 4 evenly spaced hazards
      const step = Math.floor(candidateHazards.length / 4);
      for (let k = 0; k < 4; k++) {
        hazardCols.push(candidateHazards[k * step + Math.floor(step / 2)]);
      }
    }
  } else {
    // Fallback to single ground columns
    const singleGrounds = [];
    for (let c = 1; c < numWeeks - 1; c++) {
      if (columns[c].isGround) {
        singleGrounds.push(c);
      }
    }
    if (singleGrounds.length > 0) {
      const count = Math.min(4, singleGrounds.length);
      const step = Math.floor(singleGrounds.length / count);
      for (let k = 0; k < count; k++) {
        hazardCols.push(singleGrounds[k * step + Math.floor(step / 2)]);
      }
    }
  }

  // Define initial horizontal entry/exit coordinates for each column
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    col.xEntry = col.left + (col.isGround ? 0 : 4);
    col.xExit = col.right - (col.isGround ? 0 : 4);
  }

  // Adjust entry/exit offsets dynamically based on vertical jump height dy to expand horizontal span of jumps
  for (let i = 0; i < columns.length - 1; i++) {
    const col = columns[i];
    const nextCol = columns[i + 1];
    const shouldJump = !col.isGround || !nextCol.isGround;

    if (shouldJump) {
      const dy = Math.abs(col.y - nextCol.y);
      const adjustment = Math.min(4, Math.floor(dy / 15) * 1.0);
      if (!col.isGround) {
        col.xExit -= adjustment;
      }
      if (!nextCol.isGround) {
        nextCol.xEntry += adjustment;
      }
    }
  }

  // Build keyframes sequence
  const keyframes = [];
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const isHazard = hazardCols.includes(i);

    // Land/start walking flat on this column
    keyframes.push({ x: col.xEntry, y: col.y });

    if (isHazard) {
      // Mario jumps OVER the shell inside this column!
      const xApex = (col.xEntry + col.xExit) / 2;
      let yApex = col.y - jumpHeight;
      yApex = Math.max(16, yApex);
      keyframes.push({ x: xApex, y: yApex });
    }

    // End walking flat on this column
    keyframes.push({ x: col.xExit, y: col.y });

    // Transition to the next column
    if (i < columns.length - 1) {
      const nextCol = columns[i + 1];
      const shouldJump = !col.isGround || !nextCol.isGround;

      if (shouldJump) {
        const xApex = (col.xExit + nextCol.xEntry) / 2;
        const dy = Math.abs(col.y - nextCol.y);
        // Reduce the additional jump height for large vertical climbs to make them smoother
        const currentJumpHeight = dy > 30 ? Math.max(8, jumpHeight - Math.floor(dy / 5)) : jumpHeight;
        let yApex = Math.min(col.y, nextCol.y) - currentJumpHeight;
        yApex = Math.max(16, yApex);
        keyframes.push({ x: xApex, y: yApex });
      }
    }
  }

  // De-duplicate keyframes at the exact same horizontal coordinate
  const uniqueKeyframes = [];
  keyframes.forEach((kf) => {
    if (uniqueKeyframes.length === 0 || uniqueKeyframes[uniqueKeyframes.length - 1].x !== kf.x) {
      uniqueKeyframes.push(kf);
    }
  });

  const xStart = uniqueKeyframes[0].x;
  const xEnd = uniqueKeyframes[uniqueKeyframes.length - 1].x;
  const totalX = xEnd - xStart;

  // Scale times to horizontal distance for constant horizontal speed
  const keyTimes = uniqueKeyframes.map((k) => ((k.x - xStart) / totalX).toFixed(4)).join(";");
  const values = uniqueKeyframes.map((k) => `${k.x.toFixed(1)},${k.y.toFixed(1)}`).join(";");
  const totalDuration = Math.max(numWeeks * 0.45, 6); // seconds, scales with weeks

  // Shells SVGs generation
  const shellSvgs = [];
  const shellDarkColor = isDark ? "#0e4429" : "#216e39";
  const shellBrightColor = isDark ? "#39d353" : "#40c463";
  const shellRimColor = isDark ? "#f0f6fc" : "#e1e4e8";
  const shellUnderColor = isDark ? "#fcb38a" : "#fcf8a8";
  const shellEyeColor = isDark ? "#161b22" : "#57606a";

  hazardCols.forEach((h) => {
    const col = columns[h];
    const xEntry = col.left;
    const xExit = col.right;
    
    // Times
    const tStart = (xEntry - xStart) / totalX;
    const tEnd = (xExit - xStart) / totalX;
    const t0 = Math.max(0.001, tStart - 0.02);
    const t4 = Math.min(0.999, tEnd + 0.02);
    const t2 = (tStart + tEnd) / 2;

    shellSvgs.push(`
  <!-- Shell Hazard at Week ${h} -->
  <g transform="translate(-100,-100)">
    <g id="shell-${h}">
      <!-- green dome -->
      <rect x="-5" y="-6" width="10" height="6" rx="2" fill="${shellDarkColor}"/>
      <rect x="-4" y="-8" width="8" height="2" rx="1" fill="${shellDarkColor}"/>
      <rect x="-3" y="-5" width="6" height="4" fill="${shellBrightColor}"/>
      <rect x="-2" y="-7" width="4" height="2" fill="${shellBrightColor}"/>
      <!-- white rim -->
      <rect x="-6" y="0" width="12" height="2" fill="${shellRimColor}"/>
      <!-- underside -->
      <rect x="-4" y="2" width="8" height="4" fill="${shellUnderColor}" rx="1"/>
      <!-- black holes -->
      <rect x="-3" y="3" width="2" height="2" fill="${shellEyeColor}"/>
      <rect x="1" y="3" width="2" height="2" fill="${shellEyeColor}"/>
    </g>
    <animateTransform attributeName="transform" type="translate"
      values="-100.0,-100.0;-100.0,-100.0;${(col.right + 25).toFixed(1)},${(groundY - 6).toFixed(1)};${((col.left + col.right) / 2).toFixed(1)},${(groundY - 6).toFixed(1)};${(col.left - 25).toFixed(1)},${(groundY - 6).toFixed(1)};-100.0,-100.0;-100.0,-100.0"
      keyTimes="0.0000;${t0.toFixed(4)};${(t0 + 0.0001).toFixed(4)};${t2.toFixed(4)};${t4.toFixed(4)};${(t4 + 0.0001).toFixed(4)};1.0000"
      dur="${totalDuration}s"
      repeatCount="indefinite"
      calcMode="linear"/>
  </g>`);
  });
  const shellSvgsStr = shellSvgs.join("\n  ");

  // Floating score points generation
  const pointTexts = [];
  const pointsColor = isDark ? "#e3b341" : "#b58900";

  // Real columns are from index 1 to numWeeks
  for (let i = 1; i <= numWeeks; i++) {
    const col = columns[i];
    if (col.isGround) continue; // no points on ground

    const c = i - 1;
    const week = weeks[c];
    const bestRow = Math.round((col.y + MARIO_OFFSET_Y - PADDING_TOP) / STEP);
    const day = week[bestRow];
    if (!day || day.level === 0) continue;

    const pointsMap = { 1: "+10", 2: "+30", 3: "+50", 4: "+100" };
    const score = pointsMap[day.level] || "+10";

    const x = col.xEntry;
    const yStart = col.y - 18;

    const tStart = (col.xEntry - xStart) / totalX;
    const tEnd = Math.min(0.9999, tStart + 0.015);

    pointTexts.push(`
  <text x="${x.toFixed(1)}" y="${yStart.toFixed(1)}" opacity="0" font-family="'Courier New', Courier, monospace" font-weight="bold" font-size="8px" fill="${pointsColor}" text-anchor="middle">
    ${score}
    <animate attributeName="opacity"
      values="0;0;1;0;0"
      keyTimes="0;${tStart.toFixed(4)};${tStart.toFixed(4)};${tEnd.toFixed(4)};1"
      dur="${totalDuration}s"
      repeatCount="indefinite"/>
    <animate attributeName="y"
      values="${yStart.toFixed(1)};${yStart.toFixed(1)};${(yStart - 12).toFixed(1)};${(yStart - 12).toFixed(1)}"
      keyTimes="0;${tStart.toFixed(4)};${tEnd.toFixed(4)};1"
      dur="${totalDuration}s"
      repeatCount="indefinite"/>
  </text>`);
  }
  const pointTextsStr = pointTexts.join("\n  ");

  // Simple 16x16-ish blocky Mario built from rects
  const mario = `
  <g id="mario">
    <!-- cap -->
    <rect x="-6" y="-16" width="12" height="4" fill="#e4000f"/>
    <rect x="-7" y="-13" width="14" height="3" fill="#e4000f"/>
    <!-- face -->
    <rect x="-5" y="-10" width="10" height="6" fill="#fcb38a"/>
    <!-- mustache/eyes -->
    <rect x="-5" y="-7" width="10" height="2" fill="#3a2412"/>
    <!-- body (overalls) -->
    <rect x="-6" y="-4" width="12" height="6" fill="#0058f8"/>
    <rect x="-6" y="-10" width="3" height="3" fill="#e4000f"/>
    <rect x="3" y="-10" width="3" height="3" fill="#e4000f"/>
    <!-- legs -->
    <rect x="-6" y="2" width="5" height="4" fill="#3a2412"/>
    <rect x="1" y="2" width="5" height="4" fill="#3a2412"/>
  </g>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica,Arial,sans-serif">
  <style>
    text { fill: ${textColor}; font-size: 9px; }
  </style>
  <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"/>

  <!-- contribution-style track -->
  <g>
    ${cellRectsStr}
  </g>

  <!-- ground line -->
  <line x1="${PADDING_LEFT - 4}" y1="${groundY}" x2="${width - PADDING_LEFT + 4}" y2="${groundY}" stroke="${groundColor}" stroke-width="1"/>

  <!-- shell hazards -->
  ${shellSvgsStr}

  <!-- Mario -->
  <g transform="translate(${uniqueKeyframes[0].x},${uniqueKeyframes[0].y})">
    ${mario}
    <animateTransform attributeName="transform" type="translate"
      values="${values}"
      keyTimes="${keyTimes}"
      dur="${totalDuration}s"
      repeatCount="indefinite"
      calcMode="linear"/>
  </g>

  <!-- points floating animation -->
  ${pointTextsStr}

  <text x="${PADDING_LEFT}" y="${height - 2}">@${user} —  watch mario parkour !</text>
</svg>`;

  return svg;
}

(async () => {
  try {
    const days = await fetchContributions(username);
    const weeks = toWeekGrid(days);
    const svg = buildSvg(weeks, username);
    fs.writeFileSync(outfile, svg);
    console.log(`Wrote ${outfile} (${weeks.length} weeks)`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
