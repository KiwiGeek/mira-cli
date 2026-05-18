import fs from "node:fs";
import path from "node:path";
import { chatHistoryPath } from "./paths.js";
import { parseChatConversationUrl } from "./selectors.js";

export type ChatHistoryRecord = {
  /** Lowercase ChatGPT `/c/<id>` segment for prefix matching */
  conversationId: string;
  /** Memorable handle for `mira resume <name>` */
  creativeName?: string;
  /** Canonical thread URL */
  url: string;
  title: string | null;
  /** ISO 8601 timestamp when this row was last archived into history */
  recordedAt: string;
};

type HistoryFileV1 = {
  version: 1;
  conversations: ChatHistoryRecord[];
};

const CREATIVE_VERBS = [
  "ambling", "applauding", "arguing", "backflipping", "balancing",
  "bantering", "bargaining", "barking", "bellowing", "bicycling",
  "blathering", "blinking", "blushing", "blustering", "boogying", "bouncing",
  "bowling", "boxing", "bragging", "breakdancing", "brooding",
  "browsing", "bumbling", "burbling", "cackling", "camping", "capering",
  "caroling", "cartwheeling", "cavorting", "chanting", "charging",
  "cheering", "chortling", "chuckling", "clapping", "clattering",
  "climbing", "clucking", "coasting", "composing", "congaing",
  "conspiring", "cooking", "crooning", "crouching", "cruising",
  "curtsying", "dancing", "dawdling", "daydreaming", "debating",
  "declaring", "dillydallying", "discoing", "diving", "dodging",
  "doodling", "dozing", "drifting", "drumming", "ducking", "dueling",
  "eavesdropping", "fencing", "fidgeting", "flailing", "flamencoing",
  "flapping", "flexing", "flipping", "flirting", "floating", "flouncing",
  "fluttering", "foxtrotting", "frolicking", "gallivanting", "galloping",
  "gargling", "gesturing", "giggling", "gliding", "gloating", "gobbling",
  "gossiping",
  "grumbling", "hamstering", "haggling", "hiccuping", "hitchhiking",
  "hollering", "hopping", "hovering", "howling", "humming", "jamming",
  "jibbering", "jigging", "jitterbugging", "jogging", "juggling",
  "jumping", "kayaking", "kibitzing", "kneeling", "knitting", "leaping",
  "lecturing", "levitating", "limboing", "loafing", "loitering",
  "lollygagging", "lumbering", "lunging", "lurking", "marching",
  "meandering", "meditating", "mincing", "moonwalking", "moseying",
  "mumbling", "munching", "napping", "negotiating", "noodling", "nosing",
  "orbiting", "pacing", "pantomiming", "parading", "parkouring",
  "pedaling", "peeking", "percolating", "pirouetting", "plotting",
  "plodding", "poetizing", "pondering", "poplocking", "posing", "prancing",
  "preening", "proclaiming", "prowling", "puzzling", "quacking", "quipping",
  "racing", "rambling", "ranting", "rapping", "rattling", "rebounding",
  "reclining", "riffing", "roaming", "rocketing", "rollerskating",
  "romping", "rumbling", "salsaing", "sauntering", "sashaying",
  "scampering", "scheming", "scooting", "scrambling", "serenading",
  "shadowboxing", "shambling", "shantying", "shimmying", "singing",
  "skateboarding", "skedaddling", "skipping", "skulking", "sledding",
  "sleepwalking", "slinking", "slithering", "smooching", "snacking",
  "sneaking", "snickering", "sniffing", "snuggling", "snoring",
  "snowboarding", "somersaulting", "sparring", "spelunking", "spinning",
  "splashing", "sprinting", "squabbling", "squatting", "stargazing", "striding",
  "strumming", "stumbling", "surfing", "swaggering", "swashbuckling",
  "swaying", "swimming", "swooning", "swooping", "tapdancing", "tapirizing",
  "teasing", "teetering", "tiptoeing", "tobogganing", "trampolining", "trotting",
  "trundling", "twirling", "unicycling", "vaulting", "vibing", "waddling",
  "waltzing", "wandering", "warbling", "whistling", "wiggling", "winking",
  "wobbling", "yodeling", "zigzagging", "zooming", "abducting", "abseiling",
  "airdropping", "airlifting", "airquoting", "ambushing", "apologizing",
  "auctioning", "autographing", "backstroking", "barbecuing", "barricading",
  "beatboxing", "beeping", "bickering", "birdwatching", "blacksmithing",
  "blazing", "blitzing", "bootlegging", "bouldering", "brawling", "brewing",
  "brokering", "buffeting", "busking", "cajoling", "camouflaging",
  "canoodling", "capsizing", "catapulting", "chaperoning", "charioting",
  "chirping", "choreographing", "clamoring", "clowning", "coaxing",
  "combusting", "commanding", "conjuring", "corkscrewing", "cosplaying",
  "crashing", "crocheting", "crowdsurfing", "crusading", "curating",
  "dazzling", "decoding", "defenestrating", "dejaunting", "demolishing",
  "detonating", "diplomating", "disappearing", "dithering", "dowsing",
  "embroidering", "enchiladaing", "enchanting", "evaporating", "exaggerating",
  "excavating", "exclaiming", "filibustering", "firewalking", "fishmongering",
  "flabbergasting", "flummoxing", "foraging", "freestyling", "fumbling",
  "galumphing", "gaslighting", "glamouring", "glitching", "gobsmacking",
  "grappling", "grifting", "grooving", "haunting", "heckling", "highfiving",
  "hotdogging", "hulaing", "hypnotizing", "icefishing", "improvising",
  "infiltrating", "investigating", "jaywalking", "jetskiing", "jousting",
  "karaoking", "karatechopping", "kitesurfing", "lampooning", "lassoing",
  "looting", "mamboing", "marinating", "masquerading", "merengueing",
  "micdropping", "mimeographing", "misbehaving", "monologuing", "morphing",
  "moshing", "murmuring", "narrating", "navigating", "nightcrawling",
  "ninjasneaking", "orchestrating", "overacting", "pancaking", "parachuting",
  "parleying", "patrolling", "photobombing", "picnicking", "piloting",
  "pinballing", "pogoing", "polkasliding", "pontificating", "prankcalling",
  "prestidigitating", "procrastinating", "purring", "quadskating",
  "questioning", "rappelling", "rearranging", "rebooting", "reciting",
  "ricocheting", "riverdancing", "roasting", "rollerblading", "ruminating",
  "sabotaging", "sailing", "scatting", "schmoozing", "scolding", "scribbling",
  "scubadiving", "semaphoreing", "shapechanging", "shipwrecking",
  "shoehorning", "showboating", "sidesaddling", "sightseeing", "simmering",
  "skanking", "skydiving", "slaloming", "sleuthing", "smoldering",
  "soapboxing", "speedrunning", "spellcasting", "spitballing", "spooking",
  "sprinkling", "squawking", "stampeding", "stenciling", "stirfrying",
  "storyboarding", "swashblushing", "swordfighting", "tableflipping",
  "teleporting", "tenderizing", "thunderclapping", "tightroping",
  "tinkering", "toasting", "trespassing", "tromboning", "troubleshooting",
  "tumbling", "understudying", "vanishing", "ventriloquizing", "vogueing",
  "volunteering", "waffling", "wargaming", "waterskiing", "whittling",
  "windsurfing", "wiretapping", "wordsmithing", "wrangling", "yammering",
  "yoinking", "zamboniing",
] as const;

const CREATIVE_NOUNS = [
  "accordion", "acorn", "albatross", "amulet", "anvil", "armadillo",
  "astronaut", "badger", "bagel", "banjo", "barista", "barnacle", "basilisk",
  "beagle", "beanstalk", "beetle", "beret", "biscuit", "blender", "blimp",
  "bobcat", "bongo", "boomerang", "bowie", "brando", "briefcase", "brownie",
  "bubble", "buffalo", "bumblebee", "burrito", "buttercup", "cactus",
  "calzone", "camel", "capybara", "cardigan", "carousel", "cassette",
  "cauldron", "cello", "chaplin", "cheesecake", "cheetah", "chinchilla",
  "cicada", "clooney", "cobbler", "coconut", "comet", "compass", "cookie",
  "coppola", "crumpet", "cupcake", "dench", "deniro", "dinosaur", "dolphin",
  "donut", "dragon", "dragonfly", "dylan", "eastwood", "eclair", "emu",
  "enchilada", "falcon", "fedora", "ferret", "firefly", "flamingo",
  "flapjack", "flute", "fondue", "fountain", "fox", "frisbee", "frog",
  "galaxy", "gazebo", "gecko", "giraffe", "gnome", "goblin", "goose",
  "gorgon", "gouda", "gremlin", "griffin", "guitar", "hamster", "hanks",
  "harpsichord", "hedgehog", "hepburn", "hendrix", "heron", "hippo",
  "hitchcock", "hobbit", "hologram", "iguana", "jagger", "jellybean",
  "jellyfish", "jester", "kazoo", "kebab", "koala", "kraken", "kubrick",
  "lantern", "lasagna", "lemur", "lighthouse", "llama", "lobster", "macaron",
  "mammoth", "marmot", "marshmallow", "mercury", "meringue", "mermaid",
  "meteor", "monroe", "muffin", "mushroom", "narwhal", "newt", "ninja",
  "nolan", "noodle", "ocelot", "omelet", "oracle", "origami", "otter",
  "owl", "pacino", "pancake", "pangolin", "papaya", "parrot", "parton",
  "peacock", "penguin", "phoenix", "pickle", "platypus", "possum", "pretzel",
  "pudding", "pumpkin", "puppet", "raccoon", "ravioli", "reeves", "robot",
  "salamander", "sandwich", "saxophone", "scarecrow", "scorpion", "scorsese",
  "seahorse", "shakespeare", "shark", "sherbet", "sloth", "sorcerer",
  "sparrow", "spielberg", "springsteen", "squid", "squirrel", "starlight",
  "statuette", "stoat", "streep", "swift", "swordfish", "synthesizer",
  "taco", "tapir", "tarantino", "teacup", "telescope", "toad", "tornado",
  "tortellini", "toucan", "trumpet", "turtle", "ukulele", "unicorn",
  "urchin", "vampire", "velociraptor", "waffle", "walrus", "weasel",
  "whisker", "wizard", "wombat", "xylophone", "yak", "zeppelin", "zucchini",
  "aardvark", "abacus", "anchor", "anteater", "apricot", "avocado", "badminton",
  "bagpipe", "balcony", "balloon", "bazooka", "beaker", "beignet", "belfry",
  "beyonce", "billboard", "binoculars", "bonfire", "bonsai", "bookcase",
  "broccoli", "bullock", "bungalow", "cabana", "caboose", "candelabra",
  "cannoli", "canoe", "caramel", "cash", "catapult", "chimichanga", "churro",
  "clarinet", "clementine", "clocktower", "cloudburst", "cockatoo", "coleslaw",
  "confetti", "corndog", "cornflake", "crabapple", "crocodile", "cruise",
  "cucumber", "cupboard", "dandelion", "dicaprio", "djembe", "doorknob",
  "doughnut", "dumpling", "eagle", "eggplant", "escargot", "espresso",
  "firecracker", "flan", "foster", "freeman", "frittata", "gadget",
  "gargoyle", "gibbon", "gingersnap", "goldfish", "gondola", "granola",
  "gumball", "hamburger", "harmonica", "haystack", "hummingbird", "jackson",
  "jambalaya", "jolie", "jukebox", "kangaroo", "kettledrum", "kidman",
  "kimchi", "kiwi", "lawrence", "lennon", "licorice", "macaw", "mandolin",
  "mango", "meatball", "mccartney", "mochi", "mongoose", "moose", "nacho",
  "nightingale", "nicholson", "oatmeal", "octopus", "panther", "paprika",
  "parasol", "peanut", "pelican", "pepperoni", "persimmon", "pesto", "piano",
  "pineapple", "piranha", "pitt", "popcorn", "porcupine", "presley", "quiche",
  "radish", "roberts", "samosa", "satellite", "schwarzenegger", "seesaw",
  "sinatra", "skylight", "spears", "starr", "stingray", "suitcase", "sundae",
  "tambourine", "tangerine", "theremin", "thunderbolt", "turnip", "typewriter",
  "volcano", "vuvuzela", "washington", "watermelon", "winslet", "yogurt",
  "aniston", "carpenter", "johansson", "lipa", "ortega", "pugh", "rihanna",
  "scarlett", "sweeney", "zendaya", "absinthe", "airship",
  "almanac", "alpaca", "android", "antelope", "apothecary", "aquarium",
  "archipelago", "armoire", "artichoke", "asteroid", "atlantis", "avalanche",
  "baguette", "balaclava", "banister", "barbarian", "baritone", "basement",
  "bathtub", "battleship", "bayonet", "beacon", "beetroot", "bellhop",
  "birdcage", "blackbird", "blancmange", "blizzard", "blueberry", "boggart",
  "bolero", "bonbon", "bookworm", "boombox", "briar", "broadway", "broomstick",
  "buckaroo", "bugbear", "bulldozer", "cabernet", "cabbage", "cabinet",
  "cairn", "canary", "cappuccino", "caravan", "carburetor", "cartoon",
  "catamaran", "catbird", "chandelier", "cheddar", "chimera", "chowder",
  "cinnamon", "citadel", "clarion", "clavicle", "cliffhanger", "cobweb",
  "cocktail", "codpiece", "colander", "colossus", "conch", "cornbread",
  "corsair", "cosmonaut", "coyote", "crawdad", "crescendo", "cromwell",
  "cumulus", "currant", "cyclops", "daffodil", "dagger", "daiquiri",
  "dalmatian", "davenport", "daydream", "dijon", "dirigible", "disco",
  "divan", "dodo", "dormouse", "dragonfruit", "drawbridge", "dreadnought",
  "echidna", "eclipse", "edison", "eggnog", "elixir", "emerald", "empanada",
  "emulet", "falafel", "faraday", "firehose", "fireplace", "fjord", "flannel",
  "flibbertigibbet", "florentine", "flotilla", "fogbank", "foghorn",
  "frankenstein", "frenchhorn", "fritter", "furlong", "galleon", "gambit",
  "garbanzo", "gazpacho", "gearbox", "gherkin", "gingerbread", "gizmo",
  "glacier", "glitter", "glockenspiel", "goblet", "goggles", "gondolier",
  "grackle", "guacamole", "gumdrop", "gyroscope", "haberdasher", "haggis",
  "halibut", "hammock", "haversack", "hazelnut", "helicopter", "hobgoblin",
  "honeybee", "honeydew", "hootenanny", "hornswoggle", "hotspur",
  "huckleberry", "hullabaloo", "hydra", "iceberg", "impala", "inkwell",
  "jaberwocky", "jackalope", "jalapeno", "jamboree", "javelin", "jayhawk",
  "jodhpur", "juggernaut", "junebug", "kaleidoscope", "kelp", "kimono",
  "knapsack", "kumquat", "lagoon", "lamprey", "landslide", "lariat",
  "lemonade", "leprechaun", "limousine", "lodestar", "loofah", "lyric",
  "macaroon", "maelstrom", "magneto", "mahogany", "malarkey", "manticore",
  "marimba", "marmoset", "marzipan", "mascarpone", "matador", "megaphone",
  "megalodon", "metronome", "milquetoast", "mischief", "monocle", "moonbeam",
  "moonstone", "mousetrap", "mudskipper", "muppet", "mustang", "nebula",
  "nectarine", "neptune", "nightshade", "nimbus", "obsidian", "onion",
  "opossum", "orchard", "ostrich", "palisade", "panini", "papillon",
  "parchment", "parsnip", "peashooter", "pegasus", "periscope", "piccolo",
  "pinata", "pinwheel", "pistachio", "planetarium", "plumcake", "poltergeist",
  "pomegranate", "popinjay", "porridge", "portcullis", "potsticker",
  "quasar", "quesadilla", "quokka", "rhapsody", "rhinoceros", "ricotta",
  "rickshaw", "rigatoni", "roadhouse", "rutabaga", "sarsaparilla", "satyr",
  "schooner", "scimitar", "scrimshaw", "sequoia", "shillelagh", "sidecar",
  "skylark", "snowcone", "solstice", "souffle", "spaghetti", "sphinx",
  "spork", "starfish", "stegosaurus", "stradivarius", "sugarplum",
  "sunflower", "supernova", "tadpole", "taffy", "talon", "tamale",
  "tapioca", "tarragon", "thistle", "thunderdome", "topiary", "trombone",
  "turntable", "tuxedo", "typhoon", "valkyrie", "vortex", "wainscot",
  "wallaby", "warthog", "wasabi", "windmill", "wisteria", "wolverine",
  "woodpecker", "zeppelinist",
] as const;

function emptyFile(): HistoryFileV1 {
  return { version: 1, conversations: [] };
}

function normalizeCreativeName(name: string): string {
  return name.trim().toLowerCase();
}

function isValidCreativeName(name: unknown): name is string {
  return typeof name === "string" && /^[a-z]+-[a-z]+(?:-[a-z0-9]+)?$/.test(normalizeCreativeName(name));
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function creativeNameCandidate(conversationId: string, attempt: number): string {
  const hash = hashString(`${conversationId}:${attempt}`);
  const verb = CREATIVE_VERBS[hash % CREATIVE_VERBS.length]!;
  const noun = CREATIVE_NOUNS[Math.floor(hash / CREATIVE_VERBS.length) % CREATIVE_NOUNS.length]!;
  return `${verb}-${noun}`;
}

function generateCreativeName(conversationId: string, existing: ChatHistoryRecord[]): string {
  const taken = new Set(
    existing
      .filter((r) => r.conversationId !== conversationId && r.creativeName)
      .map((r) => normalizeCreativeName(r.creativeName!)),
  );

  for (let attempt = 0; attempt < CREATIVE_VERBS.length * CREATIVE_NOUNS.length; attempt++) {
    const candidate = creativeNameCandidate(conversationId, attempt);
    if (!taken.has(candidate)) return candidate;
  }

  return `${creativeNameCandidate(conversationId, 0)}-${formatShortConversationId(conversationId, 6)}`;
}

export function conversationIdFromChatUrl(pageUrl: string): string | null {
  const canonical = parseChatConversationUrl(pageUrl);
  if (!canonical) return null;
  try {
    const u = new URL(canonical);
    const m = u.pathname.match(/^\/c\/([^/?#]+)/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function historyDir(): string {
  return path.dirname(chatHistoryPath());
}

export function loadChatHistory(): ChatHistoryRecord[] {
  const p = chatHistoryPath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<HistoryFileV1>;
    if (
      parsed &&
      parsed.version === 1 &&
      Array.isArray(parsed.conversations)
    ) {
      return parsed.conversations.filter(
        (r): r is ChatHistoryRecord =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as ChatHistoryRecord).conversationId === "string" &&
          (
            !("creativeName" in r) ||
            (r as ChatHistoryRecord).creativeName === undefined ||
            isValidCreativeName((r as ChatHistoryRecord).creativeName)
          ) &&
          typeof (r as ChatHistoryRecord).url === "string" &&
          ("title" in r ? r.title === null || typeof r.title === "string" : true) &&
          typeof (r as ChatHistoryRecord).recordedAt === "string",
      );
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn("[mira] Could not read chat history file:", (e as Error).message);
    }
  }
  return [];
}

function writeHistoryAtomic(data: HistoryFileV1): void {
  fs.mkdirSync(historyDir(), { recursive: true });
  const p = chatHistoryPath();
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

export function upsertArchivedConversation(input: {
  url: string;
  title: string | null;
  recordedAt?: Date;
}): void {
  const canonical = parseChatConversationUrl(input.url);
  const convId = canonical ? conversationIdFromChatUrl(canonical) : null;
  if (!canonical || !convId) return;

  const recordedAt = (input.recordedAt ?? new Date()).toISOString();
  const file = emptyFile();
  file.conversations = loadChatHistory();

  const idx = file.conversations.findIndex((r) => r.conversationId === convId);
  const trimmedTitle = input.title?.trim() ?? "";
  const existing = idx >= 0 ? file.conversations[idx]! : undefined;
  const row: ChatHistoryRecord = {
    conversationId: convId,
    creativeName: existing?.creativeName ?? generateCreativeName(convId, file.conversations),
    url: canonical,
    title: trimmedTitle ? trimmedTitle : existing?.title ?? null,
    recordedAt,
  };

  if (idx >= 0) {
    file.conversations[idx] = row;
  } else {
    file.conversations.push(row);
  }

  file.conversations.sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
  );

  writeHistoryAtomic(file);
}

/** Visible id prefix for tables (Docker-like short hex). */
export function formatShortConversationId(conversationId: string, len = 12): string {
  const flat = conversationId.replace(/-/g, "");
  return flat.slice(0, Math.min(len, flat.length));
}

export function formatConversationHandle(record: ChatHistoryRecord): string {
  return record.creativeName ?? formatShortConversationId(record.conversationId);
}

export type ResolvePrefixResult =
  | { kind: "none" }
  | { kind: "ambiguous"; matches: ChatHistoryRecord[] }
  | { kind: "unique"; record: ChatHistoryRecord };

export function resolveConversationPrefix(rawPrefix: string): ResolvePrefixResult {
  const raw = rawPrefix.trim().toLowerCase();
  const idPrefix = raw.replace(/-/g, "");
  if (!raw) return { kind: "none" };

  const all = loadChatHistory();
  const exactCreativeNameMatches = all.filter((r) => r.creativeName === raw);
  if (exactCreativeNameMatches.length === 1) {
    return { kind: "unique", record: exactCreativeNameMatches[0]! };
  }
  if (exactCreativeNameMatches.length > 1) {
    return { kind: "ambiguous", matches: exactCreativeNameMatches };
  }

  const matches = all.filter((r) => {
    if (r.creativeName?.startsWith(raw)) return true;
    const flat = r.conversationId.replace(/-/g, "");
    return flat.startsWith(idPrefix);
  });

  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "unique", record: matches[0]! };
  return { kind: "ambiguous", matches };
}

export function listConversationsSorted(): ChatHistoryRecord[] {
  const xs = loadChatHistory();
  return [...xs].sort(
    (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
  );
}
