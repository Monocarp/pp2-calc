// ═══════════════════════════════════════════
//  PP2 Production Calculator – app.js
// ═══════════════════════════════════════════

const D = PP2DATA;

// ── Tier → Population building ID mapping ──
const POP_BUILDING_MAP = {
  pioneers:  'PopulationPioneersHut',
  colonists: 'PopulationColonistsHouse',
  farmers:   'PopulationFarmersShack',
  townsmen:  'PopulationTownsmenHouse',
  workers:   'PopulationWorkersHouse',
  merchants: 'PopulationMerchantsMansion',
  paragons:  'PopulationParagonsResidence',
};

// Population tiers display order and labels
const POP_TIERS = [
  { key: 'pioneers',  label: 'Pioneers' },
  { key: 'colonists', label: 'Colonists' },
  { key: 'farmers',   label: 'Farmers' },
  { key: 'townsmen',  label: 'Townsmen' },
  { key: 'workers',   label: 'Workers' },
  { key: 'merchants', label: 'Merchants' },
  { key: 'paragons',  label: 'Paragons' },
];

// Service threshold: consumePerMinute >= this means "service" (boolean need)
const SERVICE_THRESHOLD = 50;

// ── Producer preferences (user-selected alternatives) ──
let producerPreferences = {};   // resourceId → buildingId
let multiProducerChoices = {};  // resourceId → [{id, name, producePerMinute, tier}]
let lastHouseCounts = null;     // saved for recalculation on preference change

// ── Identify tile-produced resources ──
const TILE_RESOURCES = new Set();
for (const t of D.tiles) {
  if (t.produces) TILE_RESOURCES.add(t.produces);
}

// ── Self-reference corrections ──
// Many buildings have inputs that share the same resource ID as their product.
// This map corrects the self-ref input to the ACTUAL resource needed.
// 'tile:xxx' = record as tile/deposit need with the given tile resource ID
// 'chain:xxx' = trace as a building-produced resource through the chain
// null = skip (military/special, not part of production chains)
const SELF_REF_CORRECTIONS = {
  // Farms/plantations needing field tiles
  LinseedFarm:          'tile:linseed_field',
  WheatFarm:            'tile:wheat_field',
  HopFarm:              'tile:hop_field',
  StrawberryFarm:       'tile:strawberry_field',
  CoffeePlantation:     'tile:coffee_bean_field',
  SugarCanePlantation:  'tile:sugar_cane_field',
  TobaccoFarm:          'tile:tobacco_field',
  CottonPlantation:     'tile:cotton_field',
  RoseCultivation:      'tile:rose_field',
  SugarBeetFarm:        'tile:sugar_beet_field',
  IndigoPlantation:     'tile:indigo_field',
  NitrateMaker:         'tile:nitrate_field',
  SilkPlantation:       'tile:mulberry_trees',
  // Mines needing deposit tiles
  ClayPit:              'tile:clay_deposit',
  CoalMineTropical:     'tile:coal_deposit_tropical',
  CoalMineNorth:        'tile:coal_deposit_north',
  GemstoneMine:         'tile:gemstone_deposit',
  GoldMineTropical:     'tile:gold_deposit_tropical',
  MarbleQuarryNorth:    'tile:marble_deposit_north',
  RockSaltMineNorth:    'tile:rock_salt_deposit_north',
  // Smelters needing ore from mines (trace further through chain)
  CopperSmelter:         'chain:copper_ore',
  CopperSmelterTropical: 'chain:copper_ore',
  CopperSmelterNorth:    'chain:copper_ore',
  IronSmelter:           'chain:iron_ore',
  IronSmelterNorth:      'chain:iron_ore',
  GoldSmelter:           'chain:gold_ore',
  GoldSmelterTropical:   'chain:gold_ore',
  LeadSmelter:           'chain:lead_ore',
  ZincSmelter:           'chain:zinc_ore',
  // Processors needing intermediate goods from other buildings
  LimeKiln:              'chain:stone',       // from Stonecutter
  SpinningMill:          'chain:wool',        // Yarn from Sheep Farm (wool)
  Tannery:               'chain:furs',        // hides from Fur Trapper
  HoneyDistillery:       'chain:beeswax',     // raw honey/wax from Apiary
  BuffaloPasture:        null,              // self-loop; not in population chains
  // Military / special (not in population goods chains)
  BootCamp:              null,
};

// ── Service building capacities (houses within range) ──
// From source ProducePerIteration — how many houses one building can serve.
// Formula: serviceCount = Math.ceil(totalHouses / capacity)
const SERVICE_CAPACITY = {
  // Water providers
  Well:             20,
  Cistern:          80,
  Drywell:           4,
  Bathhouse:        48,
  LargeThermalBath: 120,
  // Community providers
  Tavern:           36,
  HarborTavern:     65,
  Fair:             80,
  CoffeeHouse:      20,
  SportsGround:     40,
  MarketHall:       48,
  Stadium:          48,
  Cemetery:         24,
  DancingSchool:    48,
  Theatre:          80,
  // Education providers
  School:           24,
  TownSchool:      120,
  // Medical care providers
  Medicus:          24,
  Hospital:        120,
  FieldSurgeonHouse: 1,
  // Administration providers
  Townhall:         24,
  Senate:          120,
  // Other service providers
  Coiffeur:         80,
  University:       80,
};

// ══════════════════════════════════════════
//  CORE CALCULATION
// ══════════════════════════════════════════

function calculateProduction(houseCounts) {
  // 1) Aggregate final-good demand and service demand from all population tiers
  const goodsDemand = {};
  const servicesPerTier = {};    // tier → [service names] (for display)
  const serviceDemand = {};      // resId → { totalHouses, tiers: { tierLabel: houseCount } }

  for (const tier of POP_TIERS) {
    const count = houseCounts[tier.key] || 0;
    if (count <= 0) continue;

    const popBuilding = D.getBuilding(POP_BUILDING_MAP[tier.key]);
    if (!popBuilding || !popBuilding.consumePerMinute) continue;

    const services = [];

    for (const [resId, cpm] of Object.entries(popBuilding.consumePerMinute)) {
      if (cpm >= SERVICE_THRESHOLD) {
        // This is a service resource — accumulate house demand
        services.push(D.getResourceName(resId));
        if (!serviceDemand[resId]) {
          serviceDemand[resId] = { totalHouses: 0, tiers: {} };
        }
        serviceDemand[resId].totalHouses += count;
        serviceDemand[resId].tiers[tier.label] =
          (serviceDemand[resId].tiers[tier.label] || 0) + count;
        continue;
      }
      const demand = count * cpm;
      if (!goodsDemand[resId]) {
        goodsDemand[resId] = { total: 0, sources: {} };
      }
      goodsDemand[resId].total += demand;
      goodsDemand[resId].sources[tier.label] =
        (goodsDemand[resId].sources[tier.label] || 0) + demand;
    }

    if (services.length > 0) {
      servicesPerTier[tier.label] = services;
    }
  }

  // 2) Trace production chains for each demanded good
  const buildingNeeds = {};
  const tileNeeds = {};

  for (const [resId, demand] of Object.entries(goodsDemand)) {
    const endGoodName = D.getResourceName(resId);
    traceChain(resId, demand.total, endGoodName, buildingNeeds, tileNeeds, 0);
  }

  // 3) Calculate service building needs
  //    serviceBuildings[resId] = { producer, count, totalHouses, tiers }
  const serviceBuildings = {};
  const uncalculableServices = [];  // services with no building producer

  for (const [resId, demand] of Object.entries(serviceDemand)) {
    const allProducers = D.getProducersOf(resId);
    const buildingProducers = (allProducers || [])
      .filter(p => p.tier && SERVICE_CAPACITY[p.id] && SERVICE_CAPACITY[p.id] > 0);

    if (buildingProducers.length === 0) {
      // No calculable provider — list as boolean
      uncalculableServices.push({
        name: D.getResourceName(resId),
        tiers: demand.tiers,
      });
      continue;
    }

    // Pick preferred service producer
    const producer = pickServiceProducer(buildingProducers, resId);
    const capacity = SERVICE_CAPACITY[producer.id];
    const count = Math.ceil(demand.totalHouses / capacity);

    serviceBuildings[resId] = {
      producer,
      count,
      capacity,
      totalHouses: demand.totalHouses,
      tiers: demand.tiers,
    };

    // Trace input goods of the service building through the chain
    const svcName = D.getResourceName(resId) + ' (svc)';
    if (producer.inputs) {
      for (const [inputId, inputPerIteration] of Object.entries(producer.inputs)) {
        // Skip self-referencing inputs
        if (inputId === producer.produces) continue;

        // Tile resource? Record tile need
        if (TILE_RESOURCES.has(inputId)) {
          const tilesNeeded = count * inputPerIteration;
          recordTileNeed(inputId, tilesNeeded, svcName, producer.name, tileNeeds);
          continue;
        }

        // Regular input — trace through chain
        const inputCpm = producer.consumePerMinute[inputId] || 0;
        const inputDemand = count * inputCpm;
        traceChain(inputId, inputDemand, svcName, buildingNeeds, tileNeeds, 0);
      }
    }
  }

  return { goodsDemand, buildingNeeds, tileNeeds, servicesPerTier,
           serviceBuildings, uncalculableServices };
}

/**
 * Recursively trace a production chain for a resource.
 * @param {string} resourceId - resource to produce
 * @param {number} demandPerMin - how much per minute is needed
 * @param {string} endGoodName - the original population good this demand stems from
 * @param {object} buildingNeeds - accumulator for building counts
 * @param {object} tileNeeds - accumulator for tile/deposit counts
 * @param {number} depth - recursion depth guard
 */
function traceChain(resourceId, demandPerMin, endGoodName, buildingNeeds, tileNeeds, depth) {
  if (demandPerMin <= 0 || depth > 20) return;

  // Find producers
  const allProducers = D.getProducersOf(resourceId);
  if (!allProducers || allProducers.length === 0) return; // no producer known

  // Prefer building producers over tiles
  const buildingProducers = allProducers.filter(p => p.tier);
  const tileProducers = allProducers.filter(p => !p.tier);

  if (buildingProducers.length > 0) {
    // Pick best building producer (first in list = usually simplest/earliest)
    const producer = pickProducer(buildingProducers, resourceId);
    const count = demandPerMin / producer.producePerMinute;

    // Record building need
    if (!buildingNeeds[producer.id]) {
      buildingNeeds[producer.id] = { building: producer, total: 0, reasons: {} };
    }
    buildingNeeds[producer.id].total += count;
    buildingNeeds[producer.id].reasons[endGoodName] =
      (buildingNeeds[producer.id].reasons[endGoodName] || 0) + count;

    // Recurse for inputs
    if (producer.inputs) {
      for (const [inputId, inputPerIteration] of Object.entries(producer.inputs)) {
        // Self-referencing input: building consumes what it produces
        if (inputId === producer.produces) {
          const correction = SELF_REF_CORRECTIONS[producer.id];
          if (correction === null) {
            continue; // skip (military/special)
          } else if (correction && correction.startsWith('tile:')) {
            // Record as tile need: building_count × tiles_per_building
            const tileResId = correction.slice(5);
            const tilesNeeded = count * inputPerIteration;
            recordTileNeed(tileResId, tilesNeeded, endGoodName, producer.name, tileNeeds);
          } else if (correction && correction.startsWith('chain:')) {
            // Trace corrected resource through the chain
            const actualResId = correction.slice(6);
            const inputDemand = count * (producer.consumePerMinute[inputId] || 0);
            traceChain(actualResId, inputDemand, endGoodName, buildingNeeds, tileNeeds, depth + 1);
          } else {
            // Unknown self-ref — record as tile need (fallback)
            const tilesNeeded = count * inputPerIteration;
            recordTileNeed(inputId, tilesNeeded, endGoodName, producer.name, tileNeeds);
          }
          continue;
        }

        // Tile resource input: record actual tile count needed (not throughput ratio)
        if (TILE_RESOURCES.has(inputId)) {
          const tilesNeeded = count * inputPerIteration;
          recordTileNeed(inputId, tilesNeeded, endGoodName, producer.name, tileNeeds);
          continue;
        }

        // Regular building-produced input: trace through chain
        const inputCpm = producer.consumePerMinute[inputId] || 0;
        const inputDemand = count * inputCpm;
        traceChain(inputId, inputDemand, endGoodName, buildingNeeds, tileNeeds, depth + 1);
      }
    }
  } else if (tileProducers.length > 0) {
    // A resource whose only producer is a tile (shouldn't normally happen after
    // fixing self-refs, but keep as fallback)
    const tile = tileProducers[0];
    // demandPerMin is in resource units/min; each tile produces producePerIteration
    // per iteration, so tiles needed = demandPerMin / producePerMinute
    // But this should really be a raw count, so use the input amount from the caller
    const count = demandPerMin / tile.producePerMinute;
    recordTileNeed(tile.produces || resourceId, count, endGoodName, 'direct', tileNeeds);
  }
}

function recordTileNeed(resourceId, count, endGoodName, usedBy, tileNeeds) {
  if (count <= 0) return;
  const displayName = D.getResourceName(resourceId);
  if (!tileNeeds[resourceId]) {
    tileNeeds[resourceId] = { name: displayName, total: 0, reasons: {} };
  }
  tileNeeds[resourceId].total += count;
  tileNeeds[resourceId].reasons[endGoodName] =
    (tileNeeds[resourceId].reasons[endGoodName] || 0) + count;
}

/**
 * Pick the best producer from a list of building producers.
 * Checks user preferences first; falls back to highest producePerMinute.
 */
function pickProducer(producers, resourceId) {
  // Sort by efficiency (producePerMinute) descending
  const sorted = [...producers].sort((a, b) => b.producePerMinute - a.producePerMinute);

  // Record alternatives when multiple building producers exist
  if (sorted.length > 1 && resourceId) {
    if (!multiProducerChoices[resourceId]) {
      multiProducerChoices[resourceId] = sorted.map(p => ({
        id: p.id, name: p.name, producePerMinute: p.producePerMinute, tier: p.tier
      }));
    }
    // Honour user preference if set
    if (producerPreferences[resourceId]) {
      const preferred = sorted.find(p => p.id === producerPreferences[resourceId]);
      if (preferred) return preferred;
    }
  }

  return sorted[0];
}

/**
 * Pick the best service building from a list of service providers.
 * Prefers higher capacity (fewer buildings needed). Supports preferences.
 */
function pickServiceProducer(producers, resourceId) {
  // Sort by capacity descending (highest coverage first)
  const sorted = [...producers].sort(
    (a, b) => (SERVICE_CAPACITY[b.id] || 0) - (SERVICE_CAPACITY[a.id] || 0)
  );

  // Record alternatives when multiple providers exist
  if (sorted.length > 1 && resourceId) {
    if (!multiProducerChoices[resourceId]) {
      multiProducerChoices[resourceId] = sorted.map(p => ({
        id: p.id, name: p.name,
        producePerMinute: p.producePerMinute,
        serviceCapacity: SERVICE_CAPACITY[p.id] || 0,
        tier: p.tier,
        isService: true,
      }));
    }
    // Honour user preference if set
    if (producerPreferences[resourceId]) {
      const preferred = sorted.find(p => p.id === producerPreferences[resourceId]);
      if (preferred) return preferred;
    }
  }

  return sorted[0];
}


// ══════════════════════════════════════════
//  RENDERING
// ══════════════════════════════════════════

function renderResults(results) {
  const { goodsDemand, buildingNeeds, tileNeeds, servicesPerTier,
          serviceBuildings, uncalculableServices } = results;
  const resultsEl = document.getElementById('results');

  // Show results section
  resultsEl.style.display = 'block';

  // ── Goods Demand Table ──
  const demandTbody = document.querySelector('#demand-table tbody');
  demandTbody.innerHTML = '';

  const sortedGoods = Object.entries(goodsDemand)
    .sort((a, b) => b[1].total - a[1].total);

  for (const [resId, info] of sortedGoods) {
    const tr = document.createElement('tr');
    const name = D.getResourceName(resId);

    const sourceTags = Object.entries(info.sources)
      .map(([tier, amt]) => `<span class="demand-source-tag">${tier}: ${fmt(amt)}</span>`)
      .join('');

    tr.innerHTML = `
      <td>${name}</td>
      <td class="count-cell">${fmt(info.total)}</td>
      <td><div class="demand-sources">${sourceTags}</div></td>
    `;
    demandTbody.appendChild(tr);
  }

  // ── Buildings Table ──
  const buildingsTbody = document.querySelector('#buildings-table tbody');
  buildingsTbody.innerHTML = '';

  const sortedBuildings = Object.entries(buildingNeeds)
    .sort((a, b) => b[1].total - a[1].total);

  for (const [id, info] of sortedBuildings) {
    const tr = document.createElement('tr');
    const reasonEntries = Object.entries(info.reasons);
    const isShared = reasonEntries.length > 1;

    if (isShared) tr.classList.add('shared-building');

    const breakdownHtml = reasonEntries
      .sort((a, b) => b[1] - a[1])
      .map(([good, count]) =>
        `<span class="breakdown-tag"><span class="tag-count">${fmt(count)}</span>${good}</span>`
      ).join('');

    tr.innerHTML = `
      <td>${info.building.name}<br><span style="font-size:.72rem;color:#666">${info.building.tier}</span></td>
      <td class="count-cell">${fmt(info.total)}</td>
      <td><div class="breakdown">${breakdownHtml}</div></td>
    `;
    buildingsTbody.appendChild(tr);
  }

  // ── Tiles Table ──
  const tilesTbody = document.querySelector('#tiles-table tbody');
  tilesTbody.innerHTML = '';

  const sortedTiles = Object.entries(tileNeeds)
    .sort((a, b) => b[1].total - a[1].total);

  if (sortedTiles.length === 0) {
    tilesTbody.innerHTML = '<tr><td colspan="3" style="color:#666;text-align:center">None</td></tr>';
  } else {
    for (const [id, info] of sortedTiles) {
      const tr = document.createElement('tr');
      const usedByHtml = Object.entries(info.reasons)
        .sort((a, b) => b[1] - a[1])
        .map(([good, count]) =>
          `<span class="breakdown-tag"><span class="tag-count">${fmt(count)}</span>${good}</span>`
        ).join('');

      tr.innerHTML = `
        <td>${info.name}</td>
        <td class="count-cell">${fmt(info.total)}</td>
        <td><div class="breakdown">${usedByHtml}</div></td>
      `;
      tilesTbody.appendChild(tr);
    }
  }

  // ── Services ──
  const servicesEl = document.getElementById('services-list');
  servicesEl.innerHTML = '';

  const hasCalculated = Object.keys(serviceBuildings).length > 0;
  const hasUncalculable = uncalculableServices.length > 0;
  const hasTierServices = Object.keys(servicesPerTier).length > 0;

  if (!hasTierServices) {
    servicesEl.innerHTML = '<p style="color:#666">No services required (no houses selected).</p>';
  } else {
    // ── Calculated service buildings ──
    if (hasCalculated) {
      const svcTable = document.createElement('table');
      svcTable.className = 'data-table service-buildings-table';
      svcTable.innerHTML = `
        <thead><tr>
          <th>Service</th>
          <th>Building</th>
          <th class="count-header">Count</th>
          <th>Needed By</th>
        </tr></thead>
        <tbody></tbody>
      `;
      const svcTbody = svcTable.querySelector('tbody');

      const sortedSvcs = Object.entries(serviceBuildings)
        .sort((a, b) => a[1].producer.name.localeCompare(b[1].producer.name));

      for (const [resId, info] of sortedSvcs) {
        const tr = document.createElement('tr');
        const tierTags = Object.entries(info.tiers)
          .map(([tier, cnt]) =>
            `<span class="demand-source-tag">${tier}: ${cnt}</span>`
          ).join('');

        tr.innerHTML = `
          <td>${D.getResourceName(resId)}</td>
          <td>${info.producer.name}<br><span style="font-size:.72rem;color:#666">${info.producer.tier} · covers ${info.capacity} houses</span></td>
          <td class="count-cell">${info.count}</td>
          <td><div class="demand-sources">${tierTags}</div></td>
        `;
        svcTbody.appendChild(tr);
      }

      servicesEl.appendChild(svcTable);
    }

    // ── Uncalculable services (boolean) ──
    if (hasUncalculable) {
      const note = document.createElement('p');
      note.className = 'panel-note';
      note.style.marginTop = hasCalculated ? '1rem' : '0';
      note.textContent = 'Additional services required (no specific building count — coverage depends on placement):';
      servicesEl.appendChild(note);

      const grid = document.createElement('div');
      grid.className = 'services-grid';
      for (const svc of uncalculableServices) {
        const div = document.createElement('div');
        div.className = 'service-tier';
        const tierList = Object.entries(svc.tiers)
          .map(([tier, cnt]) => `<li>${tier} (${cnt} houses)</li>`).join('');
        div.innerHTML = `<h3>${svc.name}</h3><ul>${tierList}</ul>`;
        grid.appendChild(div);
      }
      servicesEl.appendChild(grid);
    }

    // ── Per-tier summary ──
    const summary = document.createElement('div');
    summary.style.marginTop = '1rem';
    summary.innerHTML = '<p class="panel-note">Services by tier:</p>';
    const grid = document.createElement('div');
    grid.className = 'services-grid';
    for (const [tier, services] of Object.entries(servicesPerTier)) {
      const div = document.createElement('div');
      div.className = 'service-tier';
      div.innerHTML = `<h3>${tier}</h3><ul>${services.map(s => `<li>${s}</li>`).join('')}</ul>`;
      grid.appendChild(div);
    }
    summary.appendChild(grid);
    servicesEl.appendChild(summary);
  }

  // Scroll to results
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


// ══════════════════════════════════════════
//  PRODUCER PREFERENCES UI
// ══════════════════════════════════════════

/**
 * Render dropdown selectors for every resource that has multiple building producers
 * in the current calculation's production chains.
 */
function renderProducerPreferences() {
  const panel = document.getElementById('producer-prefs');
  const grid  = document.getElementById('prefs-grid');

  // Sort by resource display name for stable ordering
  const entries = Object.entries(multiProducerChoices)
    .sort((a, b) => D.getResourceName(a[0]).localeCompare(D.getResourceName(b[0])));

  if (entries.length === 0) {
    panel.style.display = 'none';
    return;
  }

  grid.innerHTML = '';

  for (const [resId, options] of entries) {
    const wrap = document.createElement('div');
    wrap.className = 'pref-item';

    const label = document.createElement('label');
    label.className = 'pref-label';
    label.textContent = D.getResourceName(resId);
    label.setAttribute('for', `pref-${resId}`);

    const select = document.createElement('select');
    select.className = 'pref-select';
    select.id = `pref-${resId}`;
    select.dataset.resource = resId;

    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.id;
      // Show capacity for service buildings, production rate for goods buildings
      if (opt.isService) {
        o.textContent = `${opt.name}  (covers ${opt.serviceCapacity} houses)`;
      } else {
        o.textContent = `${opt.name}  (${fmt(opt.producePerMinute)}/min)`;
      }
      // Preserve current preference, or default to first (best)
      if (producerPreferences[resId] === opt.id) {
        o.selected = true;
      } else if (!producerPreferences[resId] && opt === options[0]) {
        o.selected = true;
      }
      select.appendChild(o);
    }

    select.addEventListener('change', onPreferenceChange);

    wrap.appendChild(label);
    wrap.appendChild(select);
    grid.appendChild(wrap);
  }

  panel.style.display = '';
}

/**
 * Handle a producer preference dropdown change — save preference and recalculate.
 */
function onPreferenceChange(e) {
  const resId = e.target.dataset.resource;
  producerPreferences[resId] = e.target.value;
  recalculate();
}

/**
 * Re-run the calculation with current house counts and preferences.
 */
function recalculate() {
  if (!lastHouseCounts) return;
  multiProducerChoices = {}; // reset so traceChain re-collects with new choices
  const results = calculateProduction(lastHouseCounts);
  renderResults(results);
  renderProducerPreferences();
}


/** Format number to 2 decimal places, dropping trailing zeros */
function fmt(n) {
  if (n >= 100) return Math.ceil(n).toString();
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, '');
  return n.toFixed(2).replace(/\.?0+$/, '');
}


// ══════════════════════════════════════════
//  EVENT WIRING
// ══════════════════════════════════════════

document.getElementById('btn-calculate').addEventListener('click', () => {
  const houseCounts = {};
  let anyNonZero = false;

  for (const tier of POP_TIERS) {
    const val = parseInt(document.getElementById(`pop-${tier.key}`).value) || 0;
    houseCounts[tier.key] = Math.max(0, val);
    if (val > 0) anyNonZero = true;
  }

  if (!anyNonZero) {
    document.getElementById('results').style.display = 'none';
    document.getElementById('producer-prefs').style.display = 'none';
    return;
  }

  // Save for recalculation on preference changes
  lastHouseCounts = houseCounts;
  multiProducerChoices = {};

  const results = calculateProduction(houseCounts);
  renderResults(results);
  renderProducerPreferences();
});

document.getElementById('btn-clear').addEventListener('click', () => {
  for (const tier of POP_TIERS) {
    document.getElementById(`pop-${tier.key}`).value = 0;
  }
  document.getElementById('results').style.display = 'none';
  document.getElementById('producer-prefs').style.display = 'none';
  producerPreferences = {};
  multiProducerChoices = {};
  lastHouseCounts = null;
});

// Auto-calculate on Enter key
document.querySelectorAll('.pop-input input').forEach(input => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('btn-calculate').click();
    }
  });
});
