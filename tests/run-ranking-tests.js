// tests/run-ranking-tests.js
const assert = require('assert');

// Copy of the parsing/normalization routine used in the app
function normalizeRankOrder(rankOrder) {
  if (!Array.isArray(rankOrder) || rankOrder.length !== 6) return null;

  const parsedRanks = rankOrder.map((rankItem, idx) => {
    const rawRank = rankItem && rankItem.rank;
    let rankNum = 0;

    if (typeof rawRank === 'number') {
      rankNum = rawRank;
    } else if (typeof rawRank === 'string') {
      rankNum = parseInt(rawRank.replace('#', '').trim(), 10) || 0;
    }

    if (!rankNum && rankOrder.length === 6) {
      rankNum = 6 - idx; // fallback: index0->6 ... index5->1
    }

    const normalizedRank = `#${rankNum}`;

    return {
      ...(rankItem || {}),
      rank: rankItem && rankItem.rank ? String(rankItem.rank) : normalizedRank,
      rankNum: Number.isInteger(rankNum) ? rankNum : 0
    };
  }).filter(item => item.rankNum >= 1 && item.rankNum <= 6);

  parsedRanks.sort((a, b) => b.rankNum - a.rankNum);

  const unique = new Set();
  const validated = parsedRanks.filter(item => {
    if (!unique.has(item.rankNum)) {
      unique.add(item.rankNum);
      return true;
    }
    return false;
  }).map(({ rankNum, ...rest }) => rest);

  return validated.length === 6 ? validated : null;
}

// Test cases
(function runTests() {
  // 1) string ranks
  const stringRanks = [
    { rank: "#6", segment: "Hook" },
    { rank: "#5", segment: "Interest" },
    { rank: "#4", segment: "Context" },
    { rank: "#3", segment: "Escalation" },
    { rank: "#2", segment: "False Winner" },
    { rank: "#1", segment: "Payoff" }
  ];
  assert(normalizeRankOrder(stringRanks), 'stringRanks should validate');

  // 2) numeric ranks
  const numericRanks = [
    { rank: 6, segment: "Hook" },
    { rank: 5, segment: "Interest" },
    { rank: 4, segment: "Context" },
    { rank: 3, segment: "Escalation" },
    { rank: 2, segment: "False Winner" },
    { rank: 1, segment: "Payoff" }
  ];
  assert(normalizeRankOrder(numericRanks), 'numericRanks should validate');

  // 3) missing ranks, ordered fallback
  const missingRanks = [
    { segment: "Hook" },
    { segment: "Interest" },
    { segment: "Context" },
    { segment: "Escalation" },
    { segment: "False Winner" },
    { segment: "Payoff" }
  ];
  const out = normalizeRankOrder(missingRanks);
  assert(out, 'missingRanks should validate via fallback');
  assert.strictEqual(out[0].rank, '#6');
  assert.strictEqual(out[5].rank, '#1');

  console.log('All ranking parse tests passed.');
})();
