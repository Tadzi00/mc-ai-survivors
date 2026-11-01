/**
 * Deterministic survival progress ladder (pure, unit-tested). Each planner turn the agent shows the bot
 * which milestones are done and the single NEXT step (order: basics, shelter and heat BEFORE better tools) with a ready-to-use skill call, so small models
 * don't have to plan the tech tree themselves. See DESIGN.md "Progress ladder".
 */
export interface ProgressFacts {
  /** item name -> count in inventory */
  items: Record<string, number>;
  foodCount: number;
  tableNearby: boolean;
  homeKnown: boolean;
  bedKnown: boolean;
  spareBedKnown: boolean;
  /** A bed block seen within 24 blocks (may be free to claim). */
  bedNear?: { x: number; y: number; z: number };
  /** In a cave / deep underground (no sky). */
  underground?: boolean;
  /** Current food bar 0-20 (optional). */
  hunger?: number;
  /** true when the bot is in a sealed, comfortable room (from RealisticSeasons), undefined if unknown */
  warmHome?: boolean;
}

export interface Milestone {
  id: string;
  label: string;
  done: boolean;
  /** What to do next when this is the first unfinished milestone. */
  hint: string;
}

const sum = (items: Record<string, number>, pred: (name: string) => boolean): number =>
  Object.entries(items).reduce((n, [k, v]) => (pred(k) ? n + v : n), 0);

export function milestones(f: ProgressFacts): Milestone[] {
  const it = f.items;
  const logs = sum(it, (n) => n.endsWith('_log'));
  const planks = sum(it, (n) => n.endsWith('_planks'));
  const woodUnits = logs * 4 + planks; // in planks
  const hasTable = f.tableNearby || (it.crafting_table ?? 0) > 0;
  const pick = (tiers: string[]): boolean => tiers.some((t) => (it[`${t}_pickaxe`] ?? 0) > 0);
  const anyPickaxe = pick(['wooden', 'stone', 'iron', 'diamond', 'netherite', 'golden']);
  const stonePickaxe = pick(['stone', 'iron', 'diamond', 'netherite']);
  const sword = sum(it, (n) => n.endsWith('_sword')) > 0;
  const cobble = it.cobblestone ?? 0;
  const buildBlocks = planks + logs + cobble + (it.dirt ?? 0);
  const wool = sum(it, (n) => n.endsWith('_wool'));
  const bedsInInv = sum(it, (n) => n.endsWith('_bed'));
  const torches = it.torch ?? 0;
  const coal = (it.coal ?? 0) + (it.charcoal ?? 0);

  const bedHint = (which: string): string => {
    if (which === 'own' && f.bedNear) {
      return `there is a bed at ${f.bedNear.x},${f.bedNear.y},${f.bedNear.z}: claim it (right-click by day, sleep by night) {"skill":"sleep","args":{}}`;
    }
    if (bedsInInv > 0) return `go inside your shelter and place it: {"skill":"place_bed","args":{}}`;
    if (wool < 3) return `need ${3 - wool} more wool for a ${which} bed: kill sheep {"skill":"attack","args":{"target":"sheep"}}`;
    return `craft the ${which} bed: {"skill":"craft","args":{"item":"white_bed","count":1}}`;
  };

  return [
    {
      id: 'wood',
      label: 'wood (8 logs)',
      // 32 planks' worth before the table; after it, 12 is enough for pickaxe + sword.
      done: woodUnits >= 32 || (hasTable && (woodUnits >= 12 || anyPickaxe)),
      hint: `{"skill":"gather","args":{"block":"log","count":${Math.max(1, 8 - Math.floor(woodUnits / 4))}}}`,
    },
    {
      id: 'table',
      label: 'crafting table',
      done: hasTable,
      hint: `{"skill":"craft","args":{"item":"crafting_table","count":1}}`,
    },
    {
      id: 'wooden_pickaxe',
      label: 'pickaxe',
      done: anyPickaxe,
      hint: `{"skill":"craft","args":{"item":"wooden_pickaxe","count":1}}`,
    },
    {
      id: 'sword',
      label: 'sword',
      done: sword,
      hint: `{"skill":"craft","args":{"item":"${cobble >= 2 ? 'stone' : 'wooden'}_sword","count":1}}`,
    },
    {
      id: 'food',
      label: 'food (5)',
      done: f.foodCount >= 5,
      hint: `hunt animals: {"skill":"attack","args":{"target":"cow"}} (or pig/chicken/sheep), then eat when hungry`,
    },
    {
      id: 'blocks',
      label: 'building blocks (70)',
      done: f.homeKnown || buildBlocks >= 70,
      hint: `have ${buildBlocks}/70: {"skill":"gather","args":{"block":"${stonePickaxe || anyPickaxe ? 'stone' : 'dirt'}","count":${Math.min(64, 70 - buildBlocks)}}}`,
    },
    {
      id: 'shelter',
      label: 'sealed shelter',
      done: f.homeKnown,
      hint: `{"skill":"build_shelter","args":{"size":5}}`,
    },
    {
      id: 'heat',
      label: 'warm shelter',
      // with temperature readings: the room must really be warm; without them: having torches is enough
      done: f.warmHome === true || (f.warmHome === undefined && torches >= 4),
      hint:
        torches >= 4 || coal > 0
          ? `inside your shelter: {"skill":"heat_room","args":{}} (a 5x5 room needs ~4 torches)`
          : `need coal for torches: {"skill":"gather","args":{"block":"coal_ore","count":3}} (needs a pickaxe)`,
    },
    {
      id: 'stone_pickaxe',
      label: 'stone pickaxe',
      done: stonePickaxe,
      hint:
        cobble >= 3
          ? `{"skill":"craft","args":{"item":"stone_pickaxe","count":1}}`
          : `need ${3 - cobble} more cobblestone: {"skill":"gather","args":{"block":"stone","count":${3 - cobble + 8}}}`,
    },
    {
      id: 'own_bed',
      label: 'own bed',
      done: f.bedKnown,
      hint: bedHint('own'),
    },
    {
      id: 'spare_bed',
      label: 'spare bed (lets a teammate be born)',
      done: f.spareBedKnown,
      hint: bedHint('spare'),
    },
  ];
}

/** Compact text block for the observation. */
export function progressText(f: ProgressFacts): string {
  const ms = milestones(f);
  let next = ms.find((m) => !m.done);
  // Hungry with nothing to eat beats every other step.
  if (f.hunger !== undefined && f.hunger <= 10 && f.foodCount === 0) {
    next = ms.find((m) => m.id === 'food') ?? next;
    if (next) next = { ...next, label: `FOOD - you are hungry (${f.hunger}/20) and have nothing to eat` };
  }
  const line = ms.map((m) => `${m.done ? '[x]' : '[ ]'} ${m.label}`).join('  ');
  // Wood and animals are on the surface: from a cave, the first step is always to get out.
  if (next && f.underground && ['wood', 'food', 'table', 'own_bed', 'spare_bed'].includes(next.id)) {
    return `PROGRESS: ${line}\nNEXT STEP (${next.label}): you are UNDERGROUND - first {"skill":"go_surface","args":{}}, then ${next.hint}`;
  }
  if (!next) return `PROGRESS: ${line}\nAll basics done. Keep food stocked, help teammates, write signs/books with what you learned.`;
  return `PROGRESS: ${line}\nNEXT STEP (${next.label}): ${next.hint}`;
}
