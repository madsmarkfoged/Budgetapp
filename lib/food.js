import { addDays, isoDate } from "./dates.js";

// ---------------- shopping list from weekly offers (Tjek / eTilbudsavis) ----------------
// Tjek's public offer search allows calls from the app's origin and needs no key. It is not an
// official, documented API, so everything here degrades to "no offers found" if it changes.
const TJEK_SEARCH = "https://squid-api.tjek.com/v2/offers/search";

const CHAINS = ["REMA 1000", "Netto", "Lidl", "Føtex", "Bilka", "Coop 365", "SuperBrugsen", "Kvickly", "Dagli'Brugsen", "Meny", "Spar", "Løvbjerg", "Min Købmand", "Lagkagehuset", "7-Eleven"];

const AARHUS = { lat: 56.1572, lng: 10.2107, place: "Aarhus C" };

const STAPLES = ["Mælk", "Æg", "Brød", "Kaffe", "Smør", "Ost", "Kylling", "Hakket oksekød", "Pasta", "Ris", "Bananer", "Yoghurt", "Toiletpapir"];

const DEFAULT_SHOP = { items: [], stores: null, meals: [], staples: ["græsk yoghurt"], days: 6, cookDays: 3, perNight: 1, plan: null,
  pantry: null, freezer: [], useFreezer: true, preferProtein: true, offerCheck: null, ...AARHUS };

const kr = (n) => new Intl.NumberFormat("da-DK", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n) + " kr.";

const chainOf = (dealerName) => CHAINS.find(c => (dealerName || "").toLowerCase().startsWith(c.toLowerCase())) || dealerName;

// The chains the user actually shops in, from card purchases in the last 90 days (2+ visits).
function usualStores(transactions) {
  const since = addDays(isoDate(new Date()), -90), n = {};
  for (const t of transactions) {
    if (!t.date || t.date < since || !(t.amount < 0)) continue;
    const d = (t.description || "").toLowerCase();
    const c = CHAINS.find(c => d.includes(c.toLowerCase().replace(/\s+/g, " ")) || d.includes(c.toLowerCase().replace(/\s+/g, "")));
    if (c) n[c] = (n[c] || 0) + 1;
  }
  return Object.entries(n).filter(([, k]) => k >= 2).sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

async function searchOffers(query, { lat, lng }) {
  const q = new URLSearchParams({ query, r_lat: lat, r_lng: lng, r_radius: 10000, limit: 40 });
  const res = await fetch(`${TJEK_SEARCH}?${q}`);
  if (!res.ok) throw new Error(`Tilbud kunne ikke hentes (${res.status}).`);
  const now = Date.now();
  return (await res.json())
    .filter(o => o.pricing?.price != null && (!o.run_till || Date.parse(o.run_till) >= now))
    .map(o => ({
      id: o.id, heading: o.heading, description: o.description || "", price: +o.pricing.price, before: o.pricing.pre_price,
      store: chainOf(o.dealer?.name), from: o.run_from, till: o.run_till, image: o.images?.thumb || null,
    }));
  // Kept in Tjek's order (best match first): the cheapest hit for "kaffe" is often capsules, not coffee.
}

// Starter meals to pick favourites from; each ingredient is also the offer search term.
const MEAL_TEMPLATES = [
  ["Kylling i karry", ["kylling", "ris", "kokosmælk", "løg"]],
  ["Spaghetti bolognese", ["hakket oksekød", "spaghetti", "hakkede tomater", "løg"]],
  ["Chili con carne", ["hakket oksekød", "kidneybønner", "hakkede tomater", "ris"]],
  ["Tacos", ["hakket oksekød", "tortilla", "ost", "salat"]],
  ["Pasta med kylling og pesto", ["kylling", "pasta", "pesto"]],
  ["Wok med kylling", ["kylling", "nudler", "wokgrøntsager"]],
  ["Lasagne", ["hakket oksekød", "lasagneplader", "hakkede tomater", "ost"]],
  ["Laks med kartofler", ["laks", "kartofler", "broccoli"]],
  ["Frikadeller med kartofler", ["hakket svinekød", "kartofler", "æg"]],
  ["Burger", ["burgerboller", "hakket oksekød", "ost", "salat"]],
  ["Pizza", ["pizzadej", "skinke", "ost", "tomatsauce"]],
  ["Omelet med bacon", ["æg", "bacon", "ost"]],
  // Protein-rich pasta dishes (roughly 40–50 g protein per portion).
  ["Kyllingepasta med hytteostsauce", ["kylling", "pasta", "hytteost", "spinat", "hvidløg"]],
  ["Bolognese med linser", ["hakket oksekød", "røde linser", "pasta", "hakkede tomater", "løg"]],
  ["Tunpasta med cherrytomater", ["tun", "pasta", "cherrytomater", "rødløg", "skyr"]],
  ["Kalkunpasta med pesto og spinat", ["kalkun", "pasta", "pesto", "spinat"]],
  ["Kylling og broccoli i parmesanpasta", ["kylling", "pasta", "broccoli", "parmesan"]],
  ["Laksepasta med citron og spinat", ["laks", "pasta", "spinat", "skyr", "citron"]],
  // Picked by the user from other recipe sites (see MEAL_SOURCE); the method is written in the app's own words.
  ["Taco pastasalat med oksekød", ["hakket oksekød", "pasta", "kidneybønner", "peberfrugt", "rødløg", "majs", "cherrytomater", "salat", "cheddar", "løg", "tacokrydderi", "creme fraiche", "mayonnaise", "salsa", "lime"]],
  ["Svensk pølseret (Gourministeriet)", ["pølser", "kartofler", "løg", "hvidløg", "paprika", "tomatpuré", "piskefløde", "ketchup", "purløg"]],
  ["Mexicansk kartoffelfad med oksekød", ["hakket oksekød", "kartofler", "løg", "hvidløg", "peberfrugt", "tacokrydderi", "tomatpuré", "bouillon", "fløde", "kidneybønner", "cheddar", "creme fraiche"]],
];

// Ingredients to pick from under "Retter", grouped like a shop.
// Ingredients to pick from, grouped the way a Danish supermarket is laid out (also the shopping-list order).
// No chain publishes an open product catalogue, so this is a hand-made list of common raw ingredients.
const INGREDIENT_GROUPS = [
  ["Grønt", ["løg", "rødløg", "skalotteløg", "forårsløg", "porre", "hvidløg", "gulerødder", "kartofler", "små kartofler", "søde kartofler", "pastinak", "persillerod", "rødbeder", "jordskokker", "knoldselleri", "bladselleri", "fennikel", "squash", "hokkaido", "aubergine", "peberfrugt", "champignon", "portobello", "kantareller", "spinat", "grønkål", "pak choi", "broccoli", "blomkål", "rosenkål", "spidskål", "hvidkål", "rødkål", "grønne bønner", "sukkerærter", "asparges", "majs", "agurk", "tomater", "cherrytomater", "salat", "icebergsalat", "rucola", "feldsalat", "radiser", "avocado", "chili", "ingefær", "citron", "lime", "persille", "basilikum", "frisk koriander", "mynte", "dild", "purløg", "rosmarin", "karse"]],
  ["Frugt", ["bananer", "æbler", "pærer", "appelsiner", "clementiner", "kiwi", "nektariner", "blommer", "blåbær", "jordbær", "hindbær", "druer", "melon", "mango", "ananas", "granatæble", "passionsfrugt", "dadler", "rosiner", "figner"]],
  ["Brød, pasta og ris", ["pasta", "spaghetti", "penne", "fusilli", "rigatoni", "tagliatelle", "lasagneplader", "frisk pasta", "tortellini", "gnocchi", "nudler", "risnudler", "ris", "jasminris", "basmatiris", "brune ris", "risottoris", "couscous", "bulgur", "quinoa", "havregryn", "müsli", "cornflakes", "tortilla", "taco shells", "pitabrød", "naanbrød", "burgerboller", "pizzadej", "butterdej", "tærtedej", "rugbrød", "toastbrød", "brød", "boller", "panko"]],
  ["Kød", ["kylling", "kyllingebryst", "kyllingeinderfilet", "kyllingelårfilet", "kyllingelår", "kyllingeunderlår", "kyllingevinger", "hel kylling", "hakket kylling", "kalkun", "hakket oksekød", "hakket svinekød", "hakket gris og kalv", "oksekød i tern", "tykstegsbøf", "højrebsbøf", "rib eye", "culotte", "svinemørbrad", "nakkefilet", "koteletter", "nakkekoteletter", "skinkeschnitzel", "flæskesteg", "flæsk", "medister", "frikadeller", "kødboller", "bacon", "skinke", "pølser", "chorizo", "salsiccia", "pepperoni", "kyllingepålæg", "lammeculotte", "andebryst"]],
  ["Fisk", ["laks", "torsk", "kuller", "mørksej", "rødspætte", "tun", "rejer", "makrel", "fiskefars", "fiskefrikadeller", "fiskepinde"]],
  ["Mejeri og æg", ["æg", "mælk", "kærnemælk", "smør", "fløde", "piskefløde", "madlavningsfløde", "creme fraiche", "skyr", "græsk yoghurt", "yoghurt", "ymer", "kvark", "proteinbudding", "ost", "revet ost", "skiveost", "mozzarella", "parmesan", "cheddar", "feta", "halloumi", "hytteost", "flødeost", "ricotta", "mascarpone", "brie"]],
  ["Bønner, linser og nødder", ["røde linser", "grønne linser", "kikærter", "kidneybønner", "sorte bønner", "hvide bønner", "edamame", "tofu", "nødder", "mandler", "cashewnødder", "peanuts", "valnødder", "peanutbutter", "solsikkekerner", "græskarkerner", "chiafrø", "sesamfrø"]],
  ["Dåser og saucer", ["hakkede tomater", "flåede tomater", "passata", "tomatpuré", "tomatsauce", "pizzasauce", "kokosmælk", "pesto", "bouillon", "soja", "østerssauce", "fiskesauce", "hoisin", "karrypasta", "sød chilisauce", "sriracha", "ketchup", "sennep", "mayonnaise", "salsa", "tahin", "honning", "oliven", "kapers", "soltørrede tomater", "rødvin", "hvidvin", "olivenolie", "rapsolie"]],
  ["Frost", ["wokgrøntsager", "ærter", "frossen spinat", "frossen broccoli", "frosne bær", "pommes frites", "frosne grøntsager", "blomkålsris"]],
  ["Krydderier", ["tacokrydderi", "oregano", "timian", "paprika", "røget paprika", "spidskommen", "karry", "garam masala", "gurkemeje", "kanel", "chiliflager", "hvidløgspulver", "laurbærblade", "kardemomme", "koriander", "muskatnød", "salt", "peber"]],
];

// How to cook the starter meals (written for the app, for the amounts in MEAL_AMOUNTS). Salt, pepper and oil
// are assumed to be at home.
const MEAL_STEPS = {
  "Kylling i karry": [30, ["Kog risen efter anvisningen på posen.", "Skær kyllingen i mundrette stykker, og hak løget.", "Brun kyllingen i lidt olie i en gryde ved høj varme i 3–4 minutter. Tag den op.", "Svits løget blødt i gryden i 3–4 minutter. Tilsæt 1–2 spsk karry, og rør rundt i et minut.", "Hæld kokosmælken i, læg kyllingen tilbage, og lad det simre i 10 minutter, til kyllingen er gennemstegt.", "Smag til med salt og peber, og server med risen."]],
  "Spaghetti bolognese": [40, ["Hak løget fint, og svits det i lidt olie i en gryde i 3–4 minutter.", "Tilsæt oksekødet, og brun det ved høj varme, mens du deler det med en grydeske.", "Tilsæt de hakkede tomater, 1 tsk oregano, salt og peber. Lad saucen simre under halvt låg i 20–25 minutter.", "Kog spaghettien i godt saltet vand efter anvisningen på pakken.", "Smag saucen til, og server den over pastaen."]],
  "Chili con carne": [40, ["Kog risen efter anvisningen på posen.", "Brun oksekødet i lidt olie i en gryde ved høj varme.", "Tilsæt 1 tsk spidskommen, 1 tsk paprika og ½ tsk chiliflager, og rør rundt i et minut.", "Tilsæt de hakkede tomater og de skyllede kidneybønner. Lad chilien simre i 20 minutter, og rør af og til.", "Smag til med salt og peber, og server med risen – gerne med en klat creme fraiche."]],
  "Tacos": [25, ["Brun oksekødet i lidt olie på en pande ved høj varme.", "Tilsæt tacokrydderi og ½ dl vand, og lad det simre i 5 minutter.", "Snit salaten, og riv osten, hvis den ikke er revet.", "Varm tortillaerne på en tør pande eller 5 minutter i ovnen ved 180 grader.", "Fyld tortillaerne med kød, salat og ost."]],
  "Pasta med kylling og pesto": [25, ["Kog pastaen i godt saltet vand.", "Skær kyllingen i strimler, og steg den i lidt olie i 6–8 minutter, til den er gennemstegt. Krydr med salt og peber.", "Hæld pastaen fra, men gem 1 dl af kogevandet.", "Vend pasta, kylling og pesto sammen med lidt af kogevandet, så det bliver cremet."]],
  "Wok med kylling": [20, ["Kog nudlerne efter anvisningen, og skyl dem kort i koldt vand.", "Skær kyllingen i tynde strimler, og steg den i olie ved høj varme i en wok eller stor pande i 5–6 minutter.", "Tilsæt wokgrøntsagerne, og steg videre i 3–4 minutter under omrøring.", "Vend nudlerne i, og smag til med 2–3 spsk soja."]],
  "Lasagne": [90, ["Tænd ovnen på 200 grader.", "Brun oksekødet i lidt olie. Tilsæt de hakkede tomater, 1 tsk oregano, salt og peber, og lad saucen simre i 15 minutter.", "Læg lag i et ovnfast fad: kødsauce, lasagneplader, kødsauce osv. Slut med et lag kødsauce. Vil du have den mere cremet, så kom en klat creme fraiche mellem lagene.", "Drys osten over.", "Bag lasagnen i 35–40 minutter, til pladerne er møre og osten er gylden. Lad den hvile 10 minutter, før den skæres."]],
  "Laks med kartofler": [35, ["Kog kartoflerne i saltet vand i 15–20 minutter, til de er møre.", "Tænd ovnen på 200 grader. Læg laksen i et ovnfast fad, og krydr med salt, peber og evt. lidt citron.", "Bag laksen i 12–15 minutter.", "Del broccolien i buketter, og kog den i 3–4 minutter.", "Server laks, kartofler og broccoli sammen."]],
  "Frikadeller med kartofler": [45, ["Rør det hakkede svinekød med ægget, 2 spsk hvedemel, 1 tsk salt og lidt peber. Lad farsen hvile i køleskabet i 15 minutter.", "Kog kartoflerne i saltet vand i 15–20 minutter.", "Form frikadeller med en ske dyppet i vand.", "Steg frikadellerne i smør eller olie ved middelvarme i 4–5 minutter på hver side, til de er gennemstegte."]],
  "Burger": [25, ["Form oksekødet til 4 bøffer, og krydr med salt og peber.", "Steg bøfferne på en varm pande i 3–4 minutter på hver side. Læg ost på det sidste minut, og læg låg på.", "Rist bollerne let på panden.", "Saml burgerne med salat og bøf."]],
  "Pizza": [30, ["Tænd ovnen på 225 grader eller det højeste, den kan.", "Rul dejen ud på en bageplade med bagepapir.", "Smør tomatsaucen ud, og fordel skinke og ost.", "Bag pizzaen i 12–15 minutter, til bunden er sprød og osten gylden."]],
  "Omelet med bacon": [15, ["Steg baconen sprød på en pande, og tag den op.", "Pisk æggene med salt, peber og evt. en sjat mælk.", "Hæld æggene på panden ved middelvarme, og rør let, til de begynder at stivne.", "Drys bacon og ost over, og læg låg på i 2–3 minutter, til omeletten er stivnet."]],
  "Kyllingepasta med hytteostsauce": [30, ["Kog pastaen i godt saltet vand.", "Skær kyllingen i tern, og steg den i lidt olie i 6–8 minutter. Krydr med salt og peber.", "Blend hytteosten med hvidløg og lidt pastavand til en glat sauce. Har du ikke en blender, så rør den sammen ved lav varme.", "Vend spinaten i panden, til den falder sammen. Tilsæt sauce og pasta, og varm det igennem ved lav varme – det må ikke koge.", "Smag til med salt og peber."]],
  "Bolognese med linser": [40, ["Hak løget fint, og svits det i lidt olie i en gryde i 3–4 minutter.", "Tilsæt oksekødet, og brun det ved høj varme.", "Tilsæt de skyllede røde linser, de hakkede tomater og 2 dl vand. Lad det simre i 20 minutter, til linserne er møre. Kom mere vand i, hvis den bliver for tyk.", "Kog pastaen imens.", "Smag saucen til med salt og peber, og server over pastaen."]],
  "Tunpasta med cherrytomater": [20, ["Kog pastaen, og lad den dryppe af.", "Halvér cherrytomaterne, hak rødløget fint, og lad tunen dryppe af.", "Rør skyren med salt, peber og evt. lidt citron.", "Vend pasta, tun, tomater, rødløg og skyrsauce sammen. Retten kan spises lun eller kold."]],
  "Kalkunpasta med pesto og spinat": [25, ["Kog pastaen i godt saltet vand.", "Skær kalkunen i strimler, og steg den i lidt olie i 6–8 minutter.", "Vend spinaten i panden, til den falder sammen.", "Tilsæt pasta, pesto og lidt kogevand, og vend det hele sammen."]],
  "Kylling og broccoli i parmesanpasta": [25, ["Kog pastaen. Kom broccolibuketterne i gryden de sidste 3 minutter.", "Skær kyllingen i tern, og steg den i lidt olie i 6–8 minutter.", "Hæld pasta og broccoli fra, men gem 1 dl kogevand.", "Vend det hele sammen med revet parmesan og kogevandet til en cremet sauce. Smag til med peber."]],
  "Taco pastasalat med oksekød": [30, ["Steg det hakkede løg klart i lidt olie på en pande.", "Tilsæt oksekødet, brun det godt, og rør tacokrydderiet i. Stil det til side.", "Dressing: Rør creme fraiche, mayonnaise og salsa sammen, og smag til med limesaft, salt og peber. Stil den på køl.", "Kog pastaen efter anvisningen, skyl den i koldt vand, og lad den dryppe af.", "Skær peberfrugt i tern, rødløg i strimler, halvér cherrytomaterne, og snit salaten. Skyl og dræn bønnerne.", "Bland pasta, grøntsager, bønner, majs, oksekød og revet cheddar i en stor skål, og vend dressingen i. Server gerne med tortillachips."]],
  "Svensk pølseret (Gourministeriet)": [30, ["Kog kartoflerne, hvis de ikke er kogt i forvejen, og skær dem i tern. Skær pølserne i mundrette stykker.", "Smelt lidt smør og olie på en stor pande, og steg hakket løg og hvidløg, til løget er klart.", "Rør paprika (og evt. et nip chili) og tomatpuré i, og lad det stege et par minutter.", "Kom pølserne på panden, og brun dem i ca. 5 minutter.", "Tilsæt kartofler, fløde og ketchup. Varm retten igennem ved middelvarme i ca. 10 minutter – lad den ikke koge kraftigt, så kartoflerne holder formen.", "Smag til med salt og peber (og lidt mere fløde, hvis der mangler sauce), og drys purløg over."]],
  "Mexicansk kartoffelfad med oksekød": [50, ["Kog de skrællede kartofler i saltet vand i 8–10 minutter, til de næsten er møre. Hæld vandet fra.", "Brun oksekødet i lidt olie på en pande eller i en gryde.", "Tilsæt hakket løg, hvidløg og peberfrugt i tern (og evt. et par hakkede jalapeños), og steg, til løget er klart.", "Rør tacokrydderi og tomatpuré i, og krydr med salt og peber.", "Hæld bouillon og fløde i, og lad det simre i ca. 5 minutter. Rør de drænede bønner i.", "Skær kartoflerne i skiver. Læg halvdelen i et smurt ovnfast fad, så halvdelen af kødsaucen, og gentag.", "Drys cheddar over, og bag retten ved 200 grader i ca. 25 minutter.", "Lad den hvile i 10 minutter, og server med creme fraiche."]],
  "Laksepasta med citron og spinat": [25, ["Kog pastaen i godt saltet vand.", "Skær laksen i tern, og steg den forsigtigt i 3–4 minutter.", "Vend spinaten i panden, til den falder sammen.", "Rør skyren med revet citronskal, saften af ½ citron, salt og peber.", "Vend pasta, laks og sauce sammen ved lav varme."]],
};

// Where a starter meal comes from, when it's based on a recipe the user picked on another site.
const MEAL_SOURCE = {
  "Taco pastasalat med oksekød": { site: "Gourministeriet", url: "https://gourministeriet.dk/taco-pastasalat-med-oksekoed/" },
  "Svensk pølseret (Gourministeriet)": { site: "Gourministeriet", url: "https://gourministeriet.dk/svensk-poelseret/" },
  "Mexicansk kartoffelfad med oksekød": { site: "Gourministeriet", url: "https://gourministeriet.dk/mexicansk-kartoffelfad-med-oksekoed-og-groentsager/" },
};

// Valdemarsro dinners to pick from under Retter. Only names and links live here (the repo is public): the
// ingredients are fetched through the worker when the user adds one, and the method when they open it.
const VALDEMARSRO = [
  ["salsiccia-pasta", "Salsiccia Pasta", "Pasta"], ["dhal", "Indisk dhal med raita", "Vegetar"], ["lasagne", "Lasagne", "Pasta"],
  ["pesto-pasta", "Pesto Pasta", "Pasta"], ["pasta-med-laks-og-spinat", "Pasta med laks og spinat", "Pasta"],
  ["marry-me-chicken-orzo-med-spinat", "Marry Me Chicken Orzo med spinat", "Kylling"], ["marry-me-chicken", "Marry Me Chicken", "Kylling"],
  ["pasta-med-moerbrad-i-tomatfloedesauce", "Pasta med mørbrad i tomatflødesauce", "Pasta"], ["nem-koedsauce-med-groentsager", "Nem kødsauce med grøntsager", "Oksekød"],
  ["one-pot-pasta-ala-cheeseburger", "One pot pasta ala Cheeseburger", "Pasta"], ["texmex-mac-and-cheese", "TexMex Mac and Cheese", "Pasta"],
  ["bagt-pasta-bolognese", "Bagt pasta bolognese", "Pasta"], ["feta-pasta-med-tomat", "Feta pasta med tomat", "Vegetar"], ["vodka-pasta", "Vodka Pasta", "Pasta"],
  ["tortellini-i-fad", "Tortellini i fad", "Pasta"], ["italienske-koedboller-i-tomatsauce-i-ovn", "Italienske kødboller i tomatsauce", "Gris"],
  ["one-pot-pasta", "One pot pasta med chorizo", "Pasta"], ["pastasalat-med-kylling-og-karrydressing", "Pastasalat med kylling og karrydressing", "Kylling"],
  ["kylling-med-parmesan", "Kylling med parmesan, salvie og tomater", "Kylling"], ["kylling-cremet-sennepssauce", "Kylling i cremet sennepssauce", "Kylling"],
  ["kylling-i-fad-med-groent", "Kylling i fad med grønt", "Kylling"], ["kyllingefrikadeller", "Kyllingefrikadeller", "Kylling"],
  ["chicken-caesar-tacos", "Chicken Cæsar Tacos", "Kylling"], ["ramen-med-sproed-kylling", "Ramen med sprød kylling", "Suppe"],
  ["nudelsuppe-med-kylling-og-groent", "Nudelsuppe med kylling og grønt", "Suppe"], ["kyllingegryde", "Marokkansk kyllingegryde", "Kylling"],
  ["hoensefrikasse", "Hønsefrikassé", "Kylling"], ["chili-con-carne", "Chili con carne", "Oksekød"],
  ["kaalpande-med-spidskaal-og-oksekoed", "Kålpande med spidskål og oksekød", "Oksekød"], ["kaalfad-med-hakket-oksekoed", "Kålfad med hakket oksekød", "Oksekød"],
  ["cheeseburger-tacos", "Cheeseburger Tacos", "Oksekød"], ["mexicansk-suppe-med-oksekoed", "Mexicansk suppe med oksekød", "Suppe"], ["ragu", "Ragu", "Oksekød"],
  ["koedboller-i-svampesauce", "Kødboller i svampesauce", "Gris"], ["lasagnesuppe", "Lasagnesuppe", "Suppe"], ["millionlinser", "Millionlinser", "Oksekød"],
  ["svensk-poelseret", "Svensk pølseret", "Gris"], ["chorizosuppe", "Chorizosuppe med kartofler og grønkål", "Suppe"],
  ["kikaertegryde", "Kikærtegryde med linser og kokosmælk", "Vegetar"], ["marokkansk-linsegryde", "Marokkansk linsegryde", "Vegetar"],
  ["boennegryde", "Bønnegryde", "Vegetar"], ["halloumi-stroganoff-med-kartoffelmos", "Halloumi Stroganoff med kartoffelmos", "Vegetar"],
  ["gullashsuppe", "Gullashsuppe", "Suppe"], ["kaalsalat-med-crispy-kylling-og-mangodressing", "Kålsalat med crispy kylling og mangodressing", "Kylling"],
];

const VR_URL = (slug) => `https://www.valdemarsro.dk/${slug}/`;

const VR_TAGS = ["Pasta", "Kylling", "Oksekød", "Gris", "Vegetar", "Suppe"];

// What people usually add to the simple starter versions.
const MEAL_EXTRAS = {
  "Spaghetti bolognese": ["gulerødder", "bladselleri", "hvidløg", "tomatpuré", "rødvin", "bouillon", "parmesan", "oregano"],
  "Lasagne": ["gulerødder", "bladselleri", "hvidløg", "tomatpuré", "mælk", "smør", "mozzarella", "parmesan"],
  "Bolognese med linser": ["gulerødder", "bladselleri", "hvidløg", "tomatpuré", "parmesan"],
  "Chili con carne": ["peberfrugt", "hvidløg", "chili", "tomatpuré", "majs", "creme fraiche"],
  "Tacos": ["peberfrugt", "majs", "avocado", "creme fraiche", "tacokrydderi", "rødløg"],
  "Kylling i karry": ["karrypasta", "peberfrugt", "hvidløg", "ingefær", "spinat"],
  "Wok med kylling": ["peberfrugt", "soja", "hvidløg", "ingefær", "chili"],
  "Pasta med kylling og pesto": ["spinat", "cherrytomater", "parmesan"],
  "Burger": ["rødløg", "bacon", "agurk"],
  "Pizza": ["mozzarella", "champignon", "peberfrugt", "oregano"],
};

// An offer fits an ingredient when every word of the ingredient starts a word in the offer heading
// ("hakket oksekød" ↔ "Hakket oksekød 8-12 %"), so "ris" doesn't match "pris".
// Offers that contain the ingredient's words but are a different product: matched as plain text in the
// lowercased heading ("yoghurt" must not become a drinking yoghurt, "ris" not rice pudding).
const OFFER_EXCLUDE = {
  "yoghurt": ["drik", "cheasy", "frugt", "jordbær", "hindbær", "vanilje", "mango", "smoothie", "müsli", "skyr"],
  "græsk yoghurt": ["drik", "frugt", "jordbær", "hindbær", "vanilje", "mango", "honning"],
  "skyr": ["drik", "frugt", "jordbær", "hindbær", "vanilje", "mango"],
  "ost": ["ostesnack", "ostepop", "ostekage", "ostehaps", "ostekiks", "flødeost", "smøreost", "hytteost", "pizza", "toast", "burger"],
  "salat": ["k-salat", "pålæg", "hønse", "kartoffelsalat", "pastasalat", "tunsalat", "rejesalat", "dressing"],
  "kylling": ["pålæg", "nugget", "kebab", "suppe", "bouillon", "salat"],
  "ris": ["risalamande", "riskiks", "rispapir", "risret", "nudel", "risengrød", "pops"],
  "pasta": ["pastasalat", "pastasauce", "pastaret", "færdigret"],
  "spaghetti": ["sauce", "færdigret"],
  "løg": ["løgringe", "stegte løg", "ristede løg", "chips"],
  "kartofler": ["chips", "pommes", "kartoffelsalat", "kartoffelmos", "rösti"],
  "laks": ["røget", "gravad", "rogn", "pålæg", "salat"],
  "hakket oksekød": ["burger", "frikadelle", "færdigret", "lasagne"],
  "hakket svinekød": ["frikadelle", "færdigret"],
  "spinat": ["chips", "tærte", "dip"],
  "fløde": ["flødeboll", "flødeost", "flødeis", "flødekaramel", "flødekage"],
  "tun": ["tunsalat", "pålæg", "mousse"],
  "ingefær": ["shot", "øl", "drik", "juice", "kiks"],
  "citron": ["juice", "vand", "sodavand", "citronmåne", "kage", "the"],
  "agurk": ["salat", "sylte", "pickles"],
  "mælk": ["kakao", "chokolade", "kokos", "mandel", "havre", "soja", "drik"],
  "æg": ["påske", "chokolade", "kinder", "nudel"],
  "kokosmælk": ["drik"],
  "bacon": ["chips", "snack"],
  "kalkun": ["pålæg"],
  "skinke": ["salat"],
  "hytteost": ["frugt"],
};

// Compound words that also count as the ingredient ("piskefløde" is fløde, "jasminris" is ris).
const OFFER_ALIASES = {
  "fløde": ["piskefløde", "madlavningsfløde", "kogefløde"],
  "ris": ["jasminris", "basmatiris", "fuldkornsris", "parboiled"],
  "pasta": ["fuldkornspasta", "penne", "fusilli", "spaghetti", "tagliatelle", "rigatoni", "farfalle"],
  "salat": ["icebergsalat", "hjertesalat", "romainesalat", "salathoved"],
  "tomatsauce": ["pastasauce", "passata"],
  "nudler": ["ægnudler", "risnudler", "woknudler"],
  "ost": ["revet ost", "skiveost", "mozzarella", "cheddar", "gouda"],
};

// Never an ingredient, whatever the words say.
const OFFER_EXCLUDE_ALL = ["kattemad", "hundemad", "kattefoder", "hundefoder", "dyrefoder", "shampoo", "vaskemiddel", "opvask"];

function offerFits(term, heading) {
  const raw = (heading || "").toLowerCase();
  const h = " " + raw.replace(/[^a-zæøå0-9]+/g, " ");
  const t = term.toLowerCase();
  if ([...OFFER_EXCLUDE_ALL, ...(OFFER_EXCLUDE[t] || [])].some(x => raw.includes(x))) return false;
  if ((OFFER_ALIASES[t] || []).some(a => raw.includes(a))) return true;
  return t.split(/\s+/).filter(Boolean).every(w => h.includes(" " + w));
}

// Normal (non-offer) shelf prices per typical pack, in kr. Tjek only knows offers, so the plan uses these
// rough estimates, and an offer's "før"-price only for ingredients not listed here (a "før"-price can
// belong to a multipack or a pricier variant, e.g. ginger shots for "ingefær").
const NORMAL_PRICES = {
  "kylling": 50, "ris": 22, "kokosmælk": 15, "løg": 10, "hakket oksekød": 50, "spaghetti": 12, "pasta": 12,
  "hakkede tomater": 8, "kidneybønner": 10, "tortilla": 22, "ost": 40, "salat": 15, "pesto": 25, "nudler": 15,
  "wokgrøntsager": 25, "lasagneplader": 15, "laks": 65, "kartofler": 20, "broccoli": 15, "hakket svinekød": 38,
  "æg": 32, "burgerboller": 22, "pizzadej": 20, "skinke": 25, "tomatsauce": 18, "bacon": 25, "røde linser": 22,
  "ingefær": 8, "hvidløg": 8, "yoghurt": 22, "agurk": 9, "salsiccia": 55, "fløde": 16, "basilikum": 15,
  "hytteost": 16, "spinat": 15, "tun": 14, "cherrytomater": 18, "rødløg": 10, "skyr": 20, "kalkun": 55,
  "parmesan": 30, "citron": 6, "græsk yoghurt": 26,
  "hakket kylling": 45, "rejer": 40, "gulerødder": 10, "bladselleri": 12, "squash": 10, "peberfrugt": 10,
  "champignon": 15, "søde kartofler": 20, "majs": 10, "ærter": 15, "chili": 8, "avocado": 10, "mozzarella": 15,
  "creme fraiche": 12, "smør": 25, "mælk": 12, "couscous": 15, "bulgur": 15, "pitabrød": 15, "tomatpuré": 8,
  "passata": 12, "kikærter": 10, "bouillon": 15, "rødvin": 50, "soja": 15, "karrypasta": 20, "tacokrydderi": 10,
  "oregano": 15,
};

const normalPrice = (term, offers) =>
  NORMAL_PRICES[term.toLowerCase()] || (offers || []).find(o => o.before && offerFits(term, o.heading))?.before || 25;

// What each starter meal needs for `servings` portions: [quantity, unit] per ingredient.
const MEAL_AMOUNTS = {
  "Kylling i karry": [4, { "kylling": [500, "g"], "ris": [300, "g"], "kokosmælk": [400, "ml"], "løg": [1, "stk"] }],
  "Spaghetti bolognese": [4, { "hakket oksekød": [500, "g"], "spaghetti": [400, "g"], "hakkede tomater": [800, "g"], "løg": [1, "stk"] }],
  "Chili con carne": [4, { "hakket oksekød": [500, "g"], "kidneybønner": [400, "g"], "hakkede tomater": [800, "g"], "ris": [300, "g"] }],
  "Tacos": [4, { "hakket oksekød": [500, "g"], "tortilla": [8, "stk"], "ost": [150, "g"], "salat": [1, "stk"] }],
  "Pasta med kylling og pesto": [4, { "kylling": [500, "g"], "pasta": [400, "g"], "pesto": [190, "g"] }],
  "Wok med kylling": [4, { "kylling": [500, "g"], "nudler": [250, "g"], "wokgrøntsager": [600, "g"] }],
  "Lasagne": [4, { "hakket oksekød": [500, "g"], "lasagneplader": [250, "g"], "hakkede tomater": [800, "g"], "ost": [150, "g"] }],
  "Laks med kartofler": [4, { "laks": [500, "g"], "kartofler": [1000, "g"], "broccoli": [500, "g"] }],
  "Frikadeller med kartofler": [4, { "hakket svinekød": [500, "g"], "kartofler": [1000, "g"], "æg": [1, "stk"] }],
  "Burger": [4, { "burgerboller": [4, "stk"], "hakket oksekød": [500, "g"], "ost": [100, "g"], "salat": [1, "stk"] }],
  "Pizza": [4, { "pizzadej": [1, "stk"], "skinke": [150, "g"], "ost": [200, "g"], "tomatsauce": [200, "g"] }],
  "Omelet med bacon": [4, { "æg": [8, "stk"], "bacon": [150, "g"], "ost": [100, "g"] }],
  "Kyllingepasta med hytteostsauce": [4, { "kylling": [600, "g"], "pasta": [400, "g"], "hytteost": [500, "g"], "spinat": [150, "g"], "hvidløg": [3, "fed"] }],
  "Bolognese med linser": [4, { "hakket oksekød": [500, "g"], "røde linser": [150, "g"], "pasta": [400, "g"], "hakkede tomater": [800, "g"], "løg": [1, "stk"] }],
  "Tunpasta med cherrytomater": [4, { "tun": [3, "dåse"], "pasta": [400, "g"], "cherrytomater": [250, "g"], "rødløg": [1, "stk"], "skyr": [300, "g"] }],
  "Kalkunpasta med pesto og spinat": [4, { "kalkun": [600, "g"], "pasta": [400, "g"], "pesto": [130, "g"], "spinat": [150, "g"] }],
  "Kylling og broccoli i parmesanpasta": [4, { "kylling": [600, "g"], "pasta": [400, "g"], "broccoli": [500, "g"], "parmesan": [60, "g"] }],
  "Taco pastasalat med oksekød": [4, { "hakket oksekød": [400, "g"], "pasta": [300, "g"], "kidneybønner": [1, "dåse"], "peberfrugt": [1, "stk"], "rødløg": [1, "stk"], "majs": [140, "g"], "cherrytomater": [150, "g"], "salat": [1, "stk"], "cheddar": [100, "g"], "løg": [1, "stk"], "tacokrydderi": [1, "stk"], "creme fraiche": [150, "g"], "mayonnaise": [100, "g"], "salsa": [230, "g"], "lime": [1, "stk"] }],
  "Svensk pølseret (Gourministeriet)": [4, { "pølser": [8, "stk"], "kartofler": [800, "g"], "løg": [1, "stk"], "hvidløg": [2, "fed"], "paprika": [3, "tsk"], "tomatpuré": [100, "g"], "piskefløde": [3, "dl"], "ketchup": [1, "spsk"], "purløg": [1, "stk"] }],
  "Mexicansk kartoffelfad med oksekød": [4, { "hakket oksekød": [500, "g"], "kartofler": [800, "g"], "løg": [1, "stk"], "hvidløg": [3, "fed"], "peberfrugt": [2, "stk"], "tacokrydderi": [3, "spsk"], "tomatpuré": [3, "spsk"], "bouillon": [2, "dl"], "fløde": [2, "dl"], "kidneybønner": [1, "dåse"], "cheddar": [80, "g"], "creme fraiche": [100, "g"] }],
  "Laksepasta med citron og spinat": [4, { "laks": [500, "g"], "pasta": [400, "g"], "spinat": [150, "g"], "skyr": [300, "g"], "citron": [1, "stk"] }],
};

// Per ingredient: typical pack size in g/ml (pack), weight of one piece/can (piece) and protein per 100 g (p).
// Rough Danish supermarket numbers – good enough to count packs and estimate protein.
const ING = {
  "kylling": { pack: 500, p: 23 }, "ris": { pack: 1000, p: 7 }, "kokosmælk": { pack: 400, p: 1.5 },
  "løg": { pack: 1000, piece: 100, p: 1 }, "hakket oksekød": { pack: 500, p: 19 }, "spaghetti": { pack: 500, p: 12 },
  "pasta": { pack: 500, p: 12 }, "hakkede tomater": { pack: 400, p: 1 }, "kidneybønner": { pack: 400, p: 8 },
  "tortilla": { pack: 320, piece: 40, p: 8 }, "ost": { pack: 300, p: 25 }, "salat": { pack: 300, piece: 300, p: 1 },
  "pesto": { pack: 190, p: 5 }, "nudler": { pack: 250, p: 10 }, "wokgrøntsager": { pack: 600, p: 2 },
  "lasagneplader": { pack: 500, p: 12 }, "laks": { pack: 500, p: 20 }, "kartofler": { pack: 2000, p: 2 },
  "broccoli": { pack: 400, piece: 400, p: 3 }, "hakket svinekød": { pack: 500, p: 18 }, "æg": { pack: 600, piece: 60, p: 13 },
  "burgerboller": { pack: 240, piece: 60, p: 9 }, "pizzadej": { pack: 400, piece: 400, p: 7 }, "skinke": { pack: 150, p: 18 },
  "tomatsauce": { pack: 400, p: 1.5 }, "bacon": { pack: 150, p: 13 }, "røde linser": { pack: 500, p: 24 },
  "ingefær": { pack: 100, p: 2 }, "hvidløg": { pack: 150, piece: 50, p: 6 }, "yoghurt": { pack: 1000, p: 4 },
  "agurk": { pack: 350, piece: 350, p: 1 }, "salsiccia": { pack: 400, p: 15 }, "fløde": { pack: 250, p: 2.5 },
  "basilikum": { pack: 30, p: 3 }, "hytteost": { pack: 250, p: 12 }, "spinat": { pack: 200, p: 3 },
  "tun": { pack: 185, piece: 130, p: 25 }, "cherrytomater": { pack: 250, p: 1 }, "rødløg": { pack: 500, piece: 100, p: 1 },
  "skyr": { pack: 450, p: 11 }, "kalkun": { pack: 500, p: 22 }, "parmesan": { pack: 150, p: 33 },
  "citron": { pack: 100, piece: 100, p: 1 }, "græsk yoghurt": { pack: 1000, p: 9 }, "hakket kylling": { pack: 400, p: 20 },
  "rejer": { pack: 250, p: 20 }, "gulerødder": { pack: 1000, piece: 80, p: 1 }, "bladselleri": { pack: 400, piece: 40, p: 1 },
  "squash": { pack: 300, piece: 300, p: 1 }, "peberfrugt": { pack: 150, piece: 150, p: 1 }, "champignon": { pack: 250, p: 3 },
  "søde kartofler": { pack: 1000, piece: 300, p: 2 }, "majs": { pack: 340, p: 3 }, "ærter": { pack: 450, p: 5 },
  "chili": { pack: 50, piece: 10, p: 2 }, "avocado": { pack: 150, piece: 150, p: 2 }, "mozzarella": { pack: 125, piece: 125, p: 18 },
  "creme fraiche": { pack: 200, p: 3 }, "smør": { pack: 250, p: 1 }, "mælk": { pack: 1000, p: 3.5 },
  "couscous": { pack: 500, p: 12 }, "bulgur": { pack: 500, p: 12 }, "pitabrød": { pack: 360, piece: 60, p: 9 },
  "tomatpuré": { pack: 140, p: 4 }, "passata": { pack: 500, p: 1.5 }, "kikærter": { pack: 400, p: 7 },
  "bouillon": { pack: 3000, p: 0 }, "rødvin": { pack: 750, p: 0 }, "soja": { pack: 150, p: 8 },
  "karrypasta": { pack: 100, p: 2 }, "tacokrydderi": { pack: 30, p: 0 }, "oregano": { pack: 10, p: 0 }, "mynte": { pack: 30, p: 3 },
};

// Rough price (kr.), pack size (g), protein (g/100 g) and piece weight for the rest of the catalogue.
const EXTRA_ING = {
  "skalotteløg": [15, 250, 1, 30], "forårsløg": [10, 100, 2, 15], "porre": [8, 300, 1, 300], "pastinak": [15, 500, 1, 150],
  "rødbeder": [12, 500, 2, 150], "knoldselleri": [15, 700, 1, 700], "aubergine": [12, 300, 1, 300], "svampe": [25, 250, 3],
  "grønkål": [20, 250, 4], "blomkål": [20, 700, 2, 700], "rosenkål": [20, 500, 3], "spidskål": [15, 800, 1, 800],
  "hvidkål": [12, 1000, 1, 1000], "rødkål": [12, 1000, 1, 1000], "grønne bønner": [20, 400, 2], "sukkerærter": [20, 150, 3],
  "tomater": [15, 500, 1, 100], "rucola": [15, 65, 3], "lime": [5, 70, 1, 70], "persille": [12, 30, 3], "frisk koriander": [12, 30, 3],
  "mynte": [15, 30, 3], "dild": [12, 30, 3], "purløg": [12, 30, 3],
  "bananer": [15, 1000, 1, 120], "æbler": [20, 1000, 0, 150], "pærer": [20, 1000, 0, 170], "appelsiner": [20, 1000, 1, 200],
  "blåbær": [25, 125, 1], "jordbær": [25, 400, 1], "hindbær": [25, 125, 1], "mango": [15, 400, 1, 400], "ananas": [20, 1000, 0, 1000],
  "druer": [20, 500, 1], "rosiner": [15, 250, 3], "dadler": [25, 250, 2],
  "penne": [12, 500, 12], "tagliatelle": [20, 500, 12], "basmatiris": [25, 1000, 7], "quinoa": [30, 500, 14], "havregryn": [12, 1000, 13],
  "müsli": [30, 750, 10], "naanbrød": [20, 260, 9, 130], "rugbrød": [20, 1000, 6, 50], "toastbrød": [15, 600, 9, 25], "brød": [25, 700, 9, 40],
  "kyllingelår": [40, 1000, 18, 120], "hakket kalv og flæsk": [40, 500, 17], "oksebøf": [60, 300, 22, 150], "oksekød i tern": [70, 500, 21],
  "svinemørbrad": [60, 500, 21], "nakkekoteletter": [45, 700, 18, 175], "flæsk": [35, 500, 14], "pølser": [30, 400, 12, 80],
  "chorizo": [25, 150, 24], "kyllingepålæg": [20, 100, 20],
  "torsk": [60, 400, 18], "makrel": [12, 125, 15], "fiskefrikadeller": [30, 400, 10, 50],
  "madlavningsfløde": [12, 250, 3], "revet ost": [25, 175, 25], "feta": [20, 200, 14], "halloumi": [30, 225, 21], "flødeost": [15, 200, 6],
  "kvark": [15, 500, 11], "proteinbudding": [12, 200, 10, 200],
  "grønne linser": [20, 500, 24], "sorte bønner": [10, 400, 8], "hvide bønner": [10, 400, 7], "edamame": [25, 400, 11],
  "nødder": [30, 200, 18], "mandler": [30, 200, 21], "peanuts": [20, 300, 25], "peanutbutter": [30, 350, 25],
  "solsikkekerner": [15, 250, 21], "chiafrø": [25, 200, 17],
  "fiskesauce": [20, 200, 5], "sød chilisauce": [20, 250, 0], "sriracha": [25, 435, 1], "ketchup": [20, 500, 1], "sennep": [15, 400, 6],
  "mayonnaise": [20, 400, 1], "salsa": [20, 300, 1], "tahin": [30, 300, 17], "honning": [30, 450, 0], "hvidvin": [50, 750, 0],
  "frossen spinat": [15, 450, 3], "frosne bær": [30, 500, 1], "pommes frites": [20, 1000, 3], "frosne grøntsager": [20, 600, 2],
  "timian": [15, 10, 0], "paprika": [15, 30, 0], "spidskommen": [15, 30, 0], "karry": [15, 30, 0], "garam masala": [20, 30, 0],
  "gurkemeje": [15, 30, 0], "kanel": [15, 30, 0], "chiliflager": [15, 30, 0], "hvidløgspulver": [15, 30, 0],
};
for (const [t, [price, pack, p, piece]] of Object.entries(EXTRA_ING)) {
  NORMAL_PRICES[t] ??= price;
  ING[t] ??= piece ? { pack, piece, p } : { pack, p };
}

// REMA 1000's normal price (kr.), pack (g) and per 100 g: kcal, fat, carbs, protein – from REMA's webshop catalogue
// (shop.rema1000.dk, fetched 3. okt. 2026; produce and spices have standard values). null = unknown.
const REMA_DATA = {
  "løg": [12, 1000, 40, 0.1, 8, 1.1],
  "rødløg": [8, 500, 40, 0.1, 8, 1.1],
  "skalotteløg": [10, 200, 72, 0.1, 17, 2.5],
  "forårsløg": [8.5, null, 32, 0.2, 6, 1.8],
  "porre": [6, null, 31, 0.3, 6, 1.5],
  "hvidløg": [6, 90, 149, 0.5, 33, 6.4],
  "gulerødder": [12, 1000, 41, 0.2, 8, 0.9],
  "kartofler": [18, 2000, 77, 0.1, 17, 2],
  "små kartofler": [10, 650, 77, 0.1, 17, 2],
  "søde kartofler": [7, null, 86, 0.1, 20, 1.6],
  "pastinak": [1.88, 130, 75, 0.3, 18, 1.2],
  "persillerod": [1.5, 100, 55, 0.6, 10, 2.3],
  "rødbeder": [28.23, 375, 71.0, 0.5, 16.0, 0.7],
  "jordskokker": [1.5, 100, 73, 0, 17, 2],
  "knoldselleri": [15, null, 42, 0.3, 9, 1.5],
  "bladselleri": [17, null, 16, 0.2, 3, 0.7],
  "fennikel": [11, null, 31, 0.2, 7, 1.2],
  "squash": [8, null, 17, 0.3, 3, 1.2],
  "hokkaido": [18, null, 40, 0.1, 9, 1.3],
  "aubergine": [9, null, 25, 0.2, 6, 1],
  "peberfrugt": [9, null, 31, 0.3, 6, 1],
  "champignon": [19, 400, 22, 0.3, 3, 3.1],
  "portobello": [20, 250, 22, 0.3, 3, 3.1],
  "kantareller": [35, 150, 32, 0.5, 7, 1.5],
  "spinat": [19, 250, 23, 0.4, 3.6, 2.9],
  "grønkål": [20.06, 250, 61.0, 1.2, 4.7, 4.7],
  "pak choi": [17, null, 13, 0.2, 2, 1.5],
  "broccoli": [13.95, 400, 28.0, 0.5, 1.9, 2.8],
  "blomkål": [17, null, 25, 0.3, 5, 1.9],
  "rosenkål": [12, 400, 43, 0.3, 9, 3.4],
  "spidskål": [13, null, 25, 0.1, 6, 1.3],
  "hvidkål": [8, 1000, 25, 0.1, 6, 1.3],
  "rødkål": [28.23, 580, 102.0, 0.5, 22.0, 1.3],
  "grønne bønner": [18, 400, 31, 0.2, 7, 1.8],
  "sukkerærter": [15, 125, 42, 0.2, 7.5, 2.8],
  "asparges": [28, 250, 20, 0.1, 3.9, 2.2],
  "majs": [7.91, 285, 79.0, 1.7, 12.0, 2.6],
  "agurk": [10, null, 15, 0.1, 3.6, 0.7],
  "tomater": [18, 500, 18, 0.2, 3.9, 0.9],
  "cherrytomater": [15, 250, 18, 0.2, 3.9, 0.9],
  "salat": [15, null, 15, 0.2, 2.9, 1.4],
  "icebergsalat": [12, null, 14, 0.1, 3, 0.9],
  "rucola": [10, 75, 25, 0.7, 3.7, 2.6],
  "feldsalat": [10, 75, 21, 0.4, 3.6, 2],
  "radiser": [9, null, 16, 0.1, 3.4, 0.7],
  "avocado": [19, null, 160, 15, 9, 2],
  "chili": [13, 70, 40, 0.4, 9, 1.9],
  "ingefær": [14, 200, 80, 0.8, 18, 1.8],
  "citron": [5, null, 29, 0.3, 9, 1.1],
  "lime": [3, 60, 30, 0.2, 11, 0.7],
  "persille": [13.05, 75, 42.0, 0.5, 7.4, 4.4],
  "basilikum": [15, null, 23, 0.6, 2.7, 3.2],
  "frisk koriander": [15, null, 23, 0.5, 3.7, 2.1],
  "mynte": [15, null, 44, 0.7, 8, 3.3],
  "dild": [10, null, 43, 1.1, 7, 3.5],
  "purløg": [10, null, 30, 0.7, 4, 3.3],
  "rosmarin": [15, 21, 131, 6, 21, 3.3],
  "karse": [7, null, 32, 0.7, 5.5, 2.6],
  "bananer": [2.5, null, 89, 0.3, 23, 1.1],
  "æbler": [2.5, null, 52, 0.2, 14, 0.3],
  "pærer": [22, 1000, 57, 0.1, 15, 0.4],
  "appelsiner": [3.5, null, 47, 0.1, 12, 0.9],
  "clementiner": [2.5, null, 47, 0.2, 12, 0.9],
  "kiwi": [20, 500, 61, 0.5, 15, 1.1],
  "nektariner": [null, null, 44, 0.3, 11, 1.1],
  "blommer": [2.5, null, 46, 0.3, 11, 0.7],
  "blåbær": [18, 125, 57, 0.3, 14, 0.7],
  "jordbær": [12, 400, 41.0, 0.5, 8.1, 0.8],
  "hindbær": [23, 125, 52, 0.7, 12, 1.2],
  "druer": [24, 500, 69, 0.2, 18, 0.7],
  "melon": [25, null, 36, 0.1, 9, 0.5],
  "mango": [14, null, 60, 0.4, 15, 0.8],
  "ananas": [20, null, 50, 0.1, 13, 0.5],
  "granatæble": [12, null, 83, 1.2, 19, 1.7],
  "passionsfrugt": [4, null, 97, 0.7, 23, 2.2],
  "dadler": [25, 400, 280, 0.4, 75, 2.5],
  "rosiner": [12.95, 250, 328.0, 0.5, 75.0, 3.3],
  "figner": [15, null, 74, 0.3, 19, 0.8],
  "pasta": [5.95, 500, 367.0, 1.5, 75.0, 12.0],
  "spaghetti": [8.95, 1000, 367.0, 1.5, 75.0, 12.0],
  "penne": [8.72, 500, 347.0, 1.8, 69.0, 11.0],
  "fusilli": [12.17, 500, 350.0, 2.2, 67.0, 12.0],
  "rigatoni": [13.5, 500, 351.0, 1.0, 70.0, 14.0],
  "tagliatelle": [null, null, 360, 1.5, 72, 13],
  "lasagneplader": [9.95, 500, 369.0, 3.8, 68.0, 14.0],
  "frisk pasta": [13.95, 500, 282.0, 1.7, 57.0, 8.7],
  "tortellini": [13.16, 250, 308.0, 7.4, 47.0, 12.0],
  "gnocchi": [19.96, 500, 153.0, 1.3, 30.0, 4.1],
  "nudler": [8.07, 250, 361.0, 3.4, 61.0, 16.0],
  "risnudler": [10.14, 200, 351.0, 0.7, 80.0, 5.6],
  "ris": [11.95, 1000, 353.0, 1.0, 78.0, 7.5],
  "jasminris": [15.02, 1000, 357.0, 1.2, 78.0, 8.0],
  "basmatiris": [17.95, 1000, 357.0, 1.2, 77.0, 9.0],
  "brune ris": [16.57, 1000, 349.0, 2.5, 72.0, 8.0],
  "risottoris": [23.01, 500, 347.0, 1.3, 75.0, 8.2],
  "couscous": [15.16, 400, 379.0, 2.3, 72.0, 14.0],
  "bulgur": [15.16, 400, 328.0, 2.3, 62.0, 11.0],
  "quinoa": [18.95, 400, 304.0, 5.7, 45.0, 14.0],
  "havregryn": [7.95, 1000, 369.0, 6.9, 57.0, 14.0],
  "müsli": [27.95, 750, 433.0, 12.0, 69.0, 9.0],
  "cornflakes": [22.28, 750, 376.0, 1.0, 82.0, 8.1],
  "tortilla": [10.7, 370, 328.0, 7.3, 55.0, 9.4],
  "taco shells": [14.95, 135, 477.0, 22.0, 63.0, 5.8],
  "pitabrød": [12.95, 375, 264.0, 3.6, 47.0, 8.9],
  "naanbrød": [12.2, 260, 290.0, 5.9, 48.0, 9.5],
  "burgerboller": [15, 330, 294.0, 5.5, 50.0, 9.6],
  "pizzadej": [10.95, 400, 271.0, 4.0, 44.0, 8.5],
  "butterdej": [11.95, 275, 380.0, 23.0, 35.0, 5.6],
  "tærtedej": [11.95, 275, 348.0, 14.0, 46.0, 5.3],
  "rugbrød": [26.5, 950, 242.0, 7.3, 33.0, 6.6],
  "toastbrød": [6, 375, 257.0, 3.1, 48.0, 7.4],
  "brød": [null, null, 250, 3, 48, 8],
  "boller": [26.5, 500, 296.0, 8.5, 43.0, 9.7],
  "panko": [13.11, 200, 358.0, 1.6, 73.0, 11.0],
  "kylling": [34.95, 450, 99.0, 1.6, 0.5, 21.0],
  "kyllingebryst": [34.95, 450, 99.0, 1.6, 0.5, 21.0],
  "kyllingeinderfilet": [25.65, 300, 101.0, 0.5, 0.5, 24.0],
  "kyllingelårfilet": [29.95, 400, 157.0, 9.0, 0.5, 19.0],
  "kyllingelår": [44.95, 1250, 194.0, 14.0, 0.5, 17.0],
  "kyllingeunderlår": [29.95, 700, 120.0, 4.4, 0.5, 20.0],
  "kyllingevinger": [32.95, 500, 139.0, 7.0, 0.5, 19.0],
  "hel kylling": [89, 1100, 184.0, 12.0, 0.5, 19.0],
  "hakket kylling": [29, 400, 121.0, 4.5, 0.5, 20.0],
  "kalkun": [null, null, 110, 1.5, 0, 24],
  "hakket oksekød": [39.95, 400, 170, 10, 0, 20],
  "hakket svinekød": [24.95, 500, 175, 11, 0, 19],
  "hakket gris og kalv": [29.95, 500, 172.0, 10.0, 0.5, 20.0],
  "oksekød i tern": [49, 300, 117.0, 3.6, 0.5, 21.0],
  "tykstegsbøf": [59.95, 300, 112.0, 2.9, 0.5, 21.0],
  "højrebsbøf": [79.95, 360, 190, 12, 0, 21],
  "rib eye": [79.95, 180, 195.0, 12.0, 0.5, 21.0],
  "culotte": [229.89, 1150, 169.0, 10.0, 0.5, 19.0],
  "svinemørbrad": [47.94, 600, 118.0, 3.8, 0.5, 21.0],
  "nakkefilet": [79.9, 1000, 176.0, 12.0, 0.5, 17.0],
  "koteletter": [29.95, 400, 133.0, 5.0, 0.5, 22.0],
  "nakkekoteletter": [34.95, 300, 227.0, 17.0, 0.5, 18.0],
  "skinkeschnitzel": [32.95, 250, 121.0, 3.4, 0.6, 22.0],
  "flæskesteg": [57.86, 1450, 240.0, 18.0, 0.5, 19.0],
  "flæsk": [29.95, 400, 316.0, 28.0, 0.5, 16.0],
  "medister": [24.95, 500, 178.0, 12.0, 5.5, 12.0],
  "frikadeller": [34.95, 360, 210.0, 14.0, 6.5, 14.0],
  "kødboller": [55.11, 700, 172.0, 12.0, 6.0, 10.0],
  "bacon": [12.95, 200, 267.0, 23.0, 0.5, 15.0],
  "skinke": [13.59, 150, 112.0, 3.6, 0.9, 19.0],
  "pølser": [24.95, 550, 252.0, 20.0, 4.9, 13.0],
  "chorizo": [9.95, 80, 355.0, 28.0, 0.5, 25.0],
  "salsiccia": [27.95, 200, 311.0, 27.0, 0.5, 17.0],
  "pepperoni": [14.95, 100, 438.0, 40.0, 1.4, 18.0],
  "kyllingepålæg": [20.14, 150, 133.0, 4.0, 1.0, 23.0],
  "lammeculotte": [79, 300, 198.0, 14.0, 0.5, 18.0],
  "andebryst": [20, 160, 289.0, 25.0, 1.0, 15.0],
  "laks": [43.95, 225, 224.0, 16.0, 0.5, 20.0],
  "torsk": [49.95, 225, 77.0, 0.6, 0.5, 18.0],
  "kuller": [45, 400, 78.0, 0.6, 0.5, 18.0],
  "mørksej": [59.95, 300, 78.0, 0.7, 0.5, 18.0],
  "rødspætte": [39, 225, 86.0, 1.5, 0.5, 18.0],
  "tun": [9.95, 140, 127.0, 1.2, 0.5, 29.0],
  "rejer": [31.95, 170, 78.0, 1.5, 0.5, 16.0],
  "makrel": [14.95, 125, 124.0, 8.9, 2.7, 8.3],
  "fiskefars": [34.95, 400, 113.0, 3.0, 9.5, 12.0],
  "fiskefrikadeller": [14.95, 120, 110.0, 2.8, 10.0, 11.0],
  "fiskepinde": [27.5, 450, 189.0, 8.4, 16.0, 12.0],
  "æg": [31.95, null, 139.0, 9.5, 1.1, 12.0],
  "mælk": [10.95, 1000, 46.0, 1.5, 4.6, 3.5],
  "kærnemælk": [13.95, 1000, 34.0, 0.5, 3.8, 3.3],
  "smør": [19.95, 200, 707.0, 78.0, 0.7, 0.6],
  "fløde": [14.95, 500, 346.0, 36.0, 3.3, 2.2],
  "piskefløde": [14.95, 500, 346.0, 36.0, 3.3, 2.2],
  "madlavningsfløde": [13.95, 250, 109.0, 7.6, 6.9, 3.4],
  "creme fraiche": [18.95, 500, 188.0, 18.0, 3.0, 2.8],
  "skyr": [19.95, 1000, 60.0, 0.5, 3.8, 10.0],
  "græsk yoghurt": [18.95, 400, 132.0, 10.0, 4.5, 6.0],
  "yoghurt": [9.95, 1000, 63.0, 3.5, 3.6, 3.6],
  "ymer": [21.95, 1000, 71.0, 3.5, 3.4, 5.6],
  "kvark": [null, null, 65, 0.2, 4, 12],
  "proteinbudding": [14.95, 200, 76.0, 1.5, 7.8, 10.0],
  "ost": [24.95, 500, 283.0, 21.0, 9.0, 15.0],
  "revet ost": [24.95, 500, 283.0, 21.0, 9.0, 15.0],
  "skiveost": [22.95, 300, 325.0, 25.0, 0.5, 24.0],
  "mozzarella": [14.36, 200, 260.0, 15.0, 3.2, 27.0],
  "parmesan": [37.95, 200, 398.0, 29.0, 0.5, 33.0],
  "cheddar": [14.95, 150, 390.0, 31.0, 3.0, 25.0],
  "feta": [19.95, 200, 260.0, 22.0, 0.5, 15.0],
  "halloumi": [22.95, 250, 245.0, 19.0, 3.0, 17.0],
  "hytteost": [14.92, 450, 75.0, 1.5, 2.3, 13.0],
  "flødeost": [19.95, 150, 251.0, 25.0, 2.8, 4.5],
  "ricotta": [12.95, 250, 97.0, 6.0, 3.7, 7.0],
  "mascarpone": [22.95, 250, 399.0, 41.0, 3.5, 4.0],
  "brie": [29.95, 350, 283.0, 23.0, 0.5, 19.0],
  "røde linser": [16.95, 400, 346.0, 2.2, 52.0, 24.0],
  "grønne linser": [16.95, 400, 352.0, 2.0, 53.0, 25.0],
  "kikærter": [7.86, 240, 117.0, 2.2, 15.0, 6.8],
  "kidneybønner": [7.15, 240, 107.0, 0.8, 14.0, 7.9],
  "sorte bønner": [7.78, 252, 107.0, 1.0, 13.0, 8.1],
  "hvide bønner": [7.15, 420, 94.0, 0.5, 15.0, 5.0],
  "edamame": [14.95, 300, 130.0, 7.2, 2.8, 11.0],
  "tofu": [16.95, 200, 87.0, 4.2, 0.5, 11.0],
  "nødder": [15.95, 66, 597.0, 49.0, 14.0, 22.0],
  "mandler": [8.95, 100, 617.0, 53.0, 5.0, 25.0],
  "cashewnødder": [22.03, 150, 588.0, 46.0, 22.0, 18.0],
  "peanuts": [9.25, 250, 626.0, 51.0, 14.0, 26.0],
  "valnødder": [13.95, 100, 686.0, 65.0, 7.0, 15.0],
  "peanutbutter": [25, 340, 607.0, 48.0, 17.0, 25.0],
  "solsikkekerner": [11.5, 400, 616.0, 54.0, 3.6, 24.0],
  "græskarkerner": [12.38, 150, 591.0, 49.0, 2.0, 34.0],
  "chiafrø": [19.95, 300, 453.0, 33.0, 4.0, 18.0],
  "sesamfrø": [12.95, 150, 657.0, 57.0, 4.6, 27.0],
  "hakkede tomater": [6.37, 400, 24.0, 0.5, 4.1, 1.0],
  "flåede tomater": [6.37, 400, 22.0, 0.5, 3.8, 1.2],
  "passata": [8.69, 500, 31.0, 0.5, 4.5, 1.5],
  "tomatpuré": [12.95, 200, 84.0, 0.5, 15.0, 3.9],
  "tomatsauce": [19.95, 400, 66.0, 3.3, 6.7, 1.9],
  "pizzasauce": [9.61, 280, 61.0, 3.3, 5.1, 1.4],
  "kokosmælk": [8.95, 400, 185.0, 18.0, 3.8, 1.3],
  "pesto": [7.16, 130, 465.0, 46.0, 7.3, 4.5],
  "bouillon": [5.5, 100, 272.0, 20.0, 19.0, 3.7],
  "soja": [10.5, 250, 38.0, 0.5, 6.4, 3.1],
  "østerssauce": [16.5, 150, 93.0, 0.5, 22.0, 1.2],
  "fiskesauce": [16.95, 150, 75.0, 0.5, 5.7, 13.0],
  "hoisin": [5, 40, 227.0, 1.6, 51.0, 1.7],
  "karrypasta": [11.91, 110, 222.0, 18.0, 10.0, 2.2],
  "sød chilisauce": [16.95, 500, 194.0, 0.5, 47.0, 0.5],
  "sriracha": [null, null, 93, 1, 19, 2],
  "ketchup": [8.8, 520, 105.0, 0.5, 23.0, 1.3],
  "sennep": [12.95, 370, 149.0, 12.0, 3.2, 7.2],
  "mayonnaise": [12.12, 400, 598.0, 66.0, 0.5, 0.7],
  "salsa": [10.95, 315, 53.0, 0.5, 11.0, 1.0],
  "tahin": [24.95, 300, 691.0, 65.0, 5.0, 20.0],
  "honning": [null, null, 304, 0, 82, 0.3],
  "oliven": [12.16, 140, 134.0, 14.0, 0.5, 0.5],
  "kapers": [7.89, 60, 37.0, 0.6, 4.0, 3.0],
  "soltørrede tomater": [13.93, 280, 393.0, 39.0, 6.3, 2.9],
  "rødvin": [null, null, 85, 0, 2.6, 0.1],
  "hvidvin": [null, null, 82, 0, 2.6, 0.1],
  "olivenolie": [49.95, 750, 828.0, 92.0, 0.5, 0.5],
  "rapsolie": [19.09, 1000, 828.0, 92.0, 0.5, 0.5],
  "wokgrøntsager": [13.95, 450, 31.0, 0.5, 4.6, 1.3],
  "ærter": [10.36, 600, 75.0, 0.7, 8.5, 6.0],
  "frossen spinat": [9.95, 750, 19.0, 0.6, 0.5, 2.2],
  "frossen broccoli": [13.95, 400, 28.0, 0.5, 1.9, 2.8],
  "frosne bær": [16.95, 200, 46.0, 0.5, 7.7, 1.2],
  "pommes frites": [9.95, 1000, 127.0, 5.1, 18.0, 1.6],
  "frosne grøntsager": [12.95, 500, 39.0, 0.5, 6.0, 1.9],
  "blomkålsris": [13.95, 350, 28.0, 0.5, 3.7, 2.0],
  "tacokrydderi": [5.25, 40, 313.0, 4.5, 59.0, 6.2],
  "oregano": [5.95, 25, 265, 4, 69, 9],
  "timian": [7.4, 30, 276, 7, 64, 9],
  "paprika": [9.67, 45, 282, 13, 54, 14],
  "røget paprika": [15, 37, 349.0, 17.0, 13.0, 15.0],
  "spidskommen": [21.39, 33, 428.0, 22.0, 34.0, 18.0],
  "karry": [5.95, 90, 325, 14, 56, 14],
  "garam masala": [null, null, 379, 15, 45, 15],
  "gurkemeje": [9.67, 40, 312, 3, 67, 10],
  "kanel": [7.95, 70, 247, 1, 81, 4],
  "chiliflager": [15, 28, 376.0, 17.0, 29.0, 12.0],
  "hvidløgspulver": [14.47, 55, 331, 0.7, 73, 17],
  "laurbærblade": [3.75, 8, 313, 8, 75, 8],
  "kardemomme": [17.72, 30, 311, 7, 68, 11],
  "koriander": [14.67, 35, 298, 18, 55, 12],
  "muskatnød": [10.95, 14, 525, 36, 49, 6],
  "salt": [null, null, 0, 0, 0, 0],
  "peber": [8.95, 100, 251, 3, 64, 10],
};
for (const [t, [price, pack, kcal, f, c, p]] of Object.entries(REMA_DATA)) {
  if (price != null) NORMAL_PRICES[t] = price;
  const cur = ING[t] || {};
  ING[t] = { ...cur, pack: pack || cur.piece || cur.pack || 100, ...(kcal != null ? { kcal, f, c, p } : {}) };
}

// Weight of one piece (g) for things recipes count in pieces ("4 kyllingebryst", "2 løg").
const PIECE_G = {
  "kylling": 150, "kyllingebryst": 150, "kyllingeinderfilet": 50, "kyllingelårfilet": 100, "kyllingelår": 250, "kyllingeunderlår": 110,
  "kyllingevinger": 50, "hel kylling": 1300, "laks": 125, "torsk": 125, "kuller": 125, "mørksej": 125, "rødspætte": 100, "tykstegsbøf": 150,
  "højrebsbøf": 180, "rib eye": 180, "koteletter": 130, "nakkekoteletter": 150, "skinkeschnitzel": 125, "svinemørbrad": 500, "pølser": 70,
  "frikadeller": 50, "kødboller": 25, "fiskefrikadeller": 50, "medister": 500, "salsiccia": 100, "andebryst": 300, "porre": 200,
  "tomater": 100, "kartofler": 100, "små kartofler": 40, "rødbeder": 150, "fennikel": 250, "hokkaido": 1000, "blomkål": 700, "broccoli": 400,
  "spidskål": 800, "hvidkål": 1000, "rødkål": 1000, "icebergsalat": 400, "pak choi": 150, "majs": 285, "ingefær": 30, "persille": 30,
  "basilikum": 30, "frisk koriander": 30, "mynte": 30, "dild": 30, "purløg": 30, "rosmarin": 10, "lime": 60, "appelsiner": 200, "kiwi": 75,
  "æbler": 150, "pærer": 170, "bananer": 120, "mango": 300, "melon": 1000, "ananas": 1000, "granatæble": 250, "brød": 40, "boller": 60,
  "toastbrød": 25, "rugbrød": 50, "taco shells": 11, "hakkede tomater": 400, "flåede tomater": 400, "kokosmælk": 400, "kidneybønner": 240,
  "kikærter": 240, "sorte bønner": 240, "hvide bønner": 240, "tun": 130, "mozzarella": 125, "feta": 200, "halloumi": 225, "tofu": 200,
};
for (const [t, g] of Object.entries(PIECE_G)) ING[t] = { ...(ING[t] || { pack: g, p: 0 }), piece: g };

const UNITS = ["g", "kg", "ml", "dl", "l", "stk", "fed", "dåse", "spsk", "tsk", "håndfuld"];

const UNIT_G = { g: 1, kg: 1000, ml: 1, dl: 100, l: 1000, spsk: 15, tsk: 5, håndfuld: 25, knivspids: 1, fed: 5 };

// Grams of an amount: pieces and cans use the ingredient's piece weight.
function toGrams(term, q, u) {
  if (!(q > 0)) return 0;
  if (UNIT_G[u]) return q * UNIT_G[u];
  const info = ING[term] || {};
  if (u === "dåse") return q * (info.piece || 400);
  return q * (info.piece || info.pack || 100); // stk, bundt, …
}

const mealServings = (m) => +m.servings || MEAL_AMOUNTS[m.name]?.[0] || 4;

const mealAmounts = (m) => m.amounts || MEAL_AMOUNTS[m.name]?.[1] || {};

// Grams of one ingredient per portion, or null when the meal doesn't say how much.
function perPortion(m, term) {
  const a = mealAmounts(m)[term];
  return a ? toGrams(term, a[0], a[1]) / mealServings(m) : null;
}

// Energy, protein, fat and carbs per portion; null when less than half the ingredients have an amount.
function mealMacros(m) {
  const terms = m.ingredients || [];
  const known = terms.filter(t => mealAmounts(m)[t]);
  if (!terms.length || known.length < terms.length / 2) return null;
  const sum = (k) => Math.round(known.reduce((s, t) => s + perPortion(m, t) * (ING[t]?.[k] || 0) / 100, 0));
  return { kcal: sum("kcal"), p: sum("p"), f: sum("f"), c: sum("c") };
}

const mealProtein = (m) => mealMacros(m)?.p ?? null;

const nice = (x) => x >= 10 ? Math.round(x) : Math.round(x * 2) / 2;

// "1.250 g" → "1,3 kg", "0.5 stk" → "½ stk".
function fmtAmount(q, u) {
  if (!(q > 0)) return "";
  if (u === "g" && q >= 1000) return `${String(Math.round(q / 100) / 10).replace(".", ",")} kg`;
  if (u === "ml" && q >= 100) return `${String(Math.round(q / 10) / 10).replace(".", ",")} dl`;
  if (u === "g" || u === "ml") return `${q < 100 ? Math.round(q / 5) * 5 || Math.round(q) : Math.round(q / 25) * 25} ${u}`;
  const v = nice(q), whole = Math.floor(v), half = v - whole >= .5;
  return `${whole || !half ? whole : ""}${half ? "½" : ""} ${u}`;
}

// Things most kitchens always have; they're never bought for a plan.
const BASICS = ["salt", "peber", "olie", "olivenolie", "rapsolie", "sukker", "hvedemel", "eddike", "bouillon", "karry", "spidskommen", "koriander", "kardemomme", "chiliflager", "oregano", "timian", "paprika", "kanel", "muskatnød", "soja"];

// Recipe lines like "800 g hakkede tomater på dåse" → { q: 800, u: "g", term: "hakkede tomater", line }.
const KNOWN_TERMS = [...new Set([...Object.keys(ING), ...INGREDIENT_GROUPS.flatMap(([, l]) => l), ...BASICS])].sort((a, b) => b.length - a.length);

const LINE_UNITS = { g: "g", gram: "g", kg: "kg", ml: "ml", dl: "dl", l: "l", liter: "l", stk: "stk", fed: "fed", dåse: "dåse", dåser: "dåse", spsk: "spsk", tsk: "tsk", håndfuld: "håndfuld", håndfulde: "håndfuld", knivspids: "knivspids", bdt: "stk", bundt: "stk", stængler: "stk", stængel: "stk", skiver: "stk", pakke: "stk", pk: "stk" };

const SKIP_LINES = /^(salt|peber|vand|salt og (friskkværnet |sort )?peber|evt\.?)\b/;

function parseIngredientLine(line) {
  let s = line.toLowerCase().replace(/\(.*?\)/g, "").split(",")[0].trim();
  const frac = { "½": .5, "¼": .25, "¾": .75 };
  const m = s.match(/^(\d+(?:[.,]\d+)?)?\s*([½¼¾])?(?:\s*-\s*\d+(?:[.,]\d+)?)?\s*/);
  let q = (m[1] ? parseFloat(m[1].replace(",", ".")) : 0) + (m[2] ? frac[m[2]] : 0);
  s = s.slice(m[0].length);
  let u = "stk";
  const w = s.split(/\s+/)[0];
  if (LINE_UNITS[w]) { u = LINE_UNITS[w]; s = s.slice(w.length).trim(); }
  if (!q) { q = 0; u = "stk"; }
  s = s.replace(/\b(frisk|friske|stødt|tørret|tørrede|finthakket|groftrevet|fintrevet|revet|koncentreret|på dåse|økologisk|små|store|stor|lille|evt\.?)\b/g, " ")
    .replace(/\d+\s*%/g, " ").replace(/\s+/g, " ").trim();
  if (!s || SKIP_LINES.test(s)) return null;
  const h = " " + s;
  const term = KNOWN_TERMS.find(t => t.split(" ").every(x => h.includes(" " + x))) || KNOWN_TERMS.find(t => t.length >= 5 && s.includes(t)) || s;
  return { q, u, term, line };
}

// A recipe from the worker → a meal: duplicate ingredients in the same unit are added together.
function mealFromRecipe(r, url) {
  const amounts = {}, ingredients = [];
  for (const line of r.ingredients || []) {
    const x = parseIngredientLine(line);
    if (!x) continue;
    if (!ingredients.includes(x.term)) ingredients.push(x.term);
    const a = amounts[x.term];
    if (!x.q) continue;
    if (!a) amounts[x.term] = [x.q, x.u];
    else if (a[1] === x.u) a[0] += x.q;
    else amounts[x.term] = [toGrams(x.term, ...a) + toGrams(x.term, x.q, x.u), "g"];
  }
  // The main ingredient (first in the plan's variety rule) is the one with the most grams.
  ingredients.sort((a, b) => (amounts[b] ? toGrams(b, ...amounts[b]) : 0) - (amounts[a] ? toGrams(a, ...amounts[a]) : 0));
  return { name: r.name || "Ny ret", ingredients, amounts, servings: r.servings || 4, url, image: r.image || null,
    lines: r.ingredients || [], steps: r.steps || null, minutes: r.minutes || null };
}

// Whether a pantry item covers an ingredient ("græsk yoghurt" covers "yoghurt", "olie" covers "olivenolie").
const covers = (have, term) => have === term || (have.length >= 4 && term.endsWith(have)) || offerFits(term, have);

// Shop walk order for the shopping list.
const AISLES = [...INGREDIENT_GROUPS.map(([g]) => g), "Andet"];

const aisleOf = (name) => {
  const n = name.toLowerCase();
  return INGREDIENT_GROUPS.find(([, l]) => l.includes(n))?.[0] || INGREDIENT_GROUPS.find(([, l]) => l.some(t => covers(t, n)))?.[0]
    || "Andet";
};

const packsFor = (term, g) => Math.max(1, Math.ceil(g / (ING[term]?.pack || 500) - 0.1));

// What a set of meals costs. Ingredients are added up across the meals and bought in whole packs (two
// chicken dishes of 600 g = 3 packs of 500 g); one without an amount costs a pack per meal. Weekly staples
// count once; what's at home (pantry, or covered by a staple) costs nothing.
function planCost(meals, staples = []) {
  const need = {};
  for (const m of meals) for (const i of m.items) {
    if (i.staple || i.have) continue;
    const x = need[i.term] ||= { term: i.term, g: 0, extra: 0, q: 0, u: i.amt?.[1], offer: i.offer, normal: i.normal };
    if (i.per) x.g += i.per * (m.portions || 1); else x.extra += 1;
    // Also in the recipe's own unit ("6 stk"), as long as every meal uses the same one.
    if (i.amt && x.u === i.amt[1]) x.q += i.amt[0] * (m.portions || 1); else x.u = null;
  }
  const buy = [...staples.map(st => ({ ...st, g: 0, packs: 1 })), ...Object.values(need).map(x => ({ ...x, packs: (x.g ? packsFor(x.term, x.g) : 0) + x.extra }))];
  return {
    buy,
    total: buy.reduce((s, x) => s + x.packs * (x.offer?.price ?? x.normal), 0),
    normal: buy.reduce((s, x) => s + x.packs * x.normal, 0),
  };
}

// Dinner plan built from this week's offers: for each store (and each pair of stores) pick the meals that
// save the most there and price the whole shop, normal-price items and the weekly staples included. The
// cheapest option wins; a second store must save at least 25 kr. to be worth the trip. Besides the offers,
// a meal scores for being a favourite (20 kr.), for using what's in the fridge, for protein above 25 g a
// portion (1 kr. per g) and for how it was rated after cooking.
function planWeek(pool, offersByTerm, stores, count, { staples = [], rejected = [], pantry = [], portions = 3, protein = true } = {}) {
  const terms = [...new Set([...staples, ...pool.flatMap(m => m.ingredients)])];
  const best = {}, normal = {};
  for (const t of terms) {
    best[t] = {};
    normal[t] = normalPrice(t, offersByTerm[t]);
    for (const o of offersByTerm[t] || [])
      if (stores.includes(o.store) && !best[t][o.store] && offerFits(t, o.heading) && !rejected.includes((o.heading || "").toLowerCase())
        && !(Date.parse(o.from) > Date.now())) best[t][o.store] = o; // next week's offers count once they start
  }
  // An ingredient a weekly staple already covers ("yoghurt" ← "græsk yoghurt") isn't bought again.
  const byStaple = (t) => !staples.includes(t) && staples.some(st => offerFits(t, st));
  const haveOf = (t) => pantry.find(p => covers(p.term, t));
  const offerIn = (t, set) => set.map(st => best[t][st]).filter(Boolean).sort((x, y) => x.price - y.price)[0] || null;
  const evaluate = (set) => {
    const rated = pool.map(m => {
      const items = m.ingredients.map(t => {
        const per = perPortion(m, t), have = haveOf(t), a = mealAmounts(m)[t];
        const amt = a ? [a[0] / mealServings(m), a[1]] : null; // amount per portion in the recipe's own unit
        if (byStaple(t)) return { term: t, per, amt, offer: null, normal: 0, staple: true };
        if (have) return { term: t, per, amt, offer: null, normal: normal[t], have: true, fresh: !have.always };
        return { term: t, per, amt, offer: offerIn(t, set), normal: normal[t] };
      });
      const packs = (i) => i.per ? packsFor(i.term, i.per * portions) : 1;
      const saving = items.reduce((s, i) => s + (i.offer ? packs(i) * Math.max(0, i.normal - i.offer.price) : 0) + (i.fresh ? i.normal + 10 : 0), 0);
      const macros = mealMacros(m), prot = macros?.p ?? null;
      const taste = Math.max(-40, Math.min(30, 8 * (m.up || 0) - 15 * (m.down || 0)));
      return { mealId: m.id, name: m.name, url: m.url || null, fav: !!m.fav, protein: prot, macros, portions, items,
        value: saving + (m.fav ? 20 : 0) + taste + (protein && prot ? Math.max(0, prot - 25) : 0) };
    }).sort((x, y) => y.value - x.value);
    // Variety: no two meals built on the same main ingredient (the first one listed, e.g. "laks").
    const meals = [], used = new Set();
    for (const r of rated) if (meals.length < count && !used.has(r.items[0]?.term)) { meals.push(r); used.add(r.items[0]?.term); }
    for (const r of rated) if (meals.length < count && !meals.includes(r)) meals.push(r);
    const fixed = staples.map(t => ({ term: t, offer: offerIn(t, set), normal: normal[t] }));
    return { stores: set, meals, staples: fixed, alts: rated.filter(r => !meals.includes(r)), ...planCost(meals, fixed) };
  };
  const pairs = stores.flatMap((x, i) => stores.slice(i + 1).map(y => [x, y]));
  const options = [...stores.map(x => [x]), ...pairs].map(evaluate)
    .sort((x, y) => (x.total + (x.stores.length > 1 ? 25 : 0)) - (y.total + (y.stores.length > 1 ? 25 : 0)));
  return { ...options[0], compare: options.slice(0, 4).map(o => ({ stores: o.stores, total: o.total })) };
}

export { TJEK_SEARCH, CHAINS, AARHUS, STAPLES, DEFAULT_SHOP, kr, chainOf, usualStores, searchOffers, MEAL_TEMPLATES, INGREDIENT_GROUPS, MEAL_STEPS, MEAL_SOURCE, VALDEMARSRO, VR_URL, VR_TAGS, MEAL_EXTRAS, OFFER_EXCLUDE, OFFER_ALIASES, OFFER_EXCLUDE_ALL, offerFits, NORMAL_PRICES, normalPrice, MEAL_AMOUNTS, ING, EXTRA_ING, REMA_DATA, PIECE_G, UNITS, UNIT_G, toGrams, mealServings, mealAmounts, perPortion, mealMacros, mealProtein, nice, fmtAmount, BASICS, KNOWN_TERMS, LINE_UNITS, SKIP_LINES, parseIngredientLine, mealFromRecipe, covers, AISLES, aisleOf, packsFor, planCost, planWeek };
