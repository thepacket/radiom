/** EIBI shortwave schedule field translators.
 *
 *  The EIBI CSV uses short codes for language, target area, country
 *  (ITU prefix), and transmitter site. This module turns each into a
 *  human-readable string with a fall-through to the original code when
 *  unknown.
 *
 *  Code lists derived from the EIBI README (eibispace.de/dx/README.TXT).
 */

const LANGUAGE: Record<string, string> = {
  A: 'Arabic', Ab: 'Abkhaz', Ac: 'Acoli', Af: 'Afar', Ag: 'Aguaruna',
  Ah: 'Amharic', Ai: 'Aymara', Aj: 'Azerbaijani', Ak: 'Akha',
  Al: 'Albanian', Am: 'Amharic', An: 'Angas', Ao: 'Oromo',
  Aq: 'Aceh', Ar: 'Arabic', As: 'Assamese', At: 'Aceh',
  Au: 'Mauritanian Arabic', Av: 'Avar', Aw: 'Awadhi',
  Ay: 'Aymara', Az: 'Azerbaijani',
  B: 'Bengali', Ba: 'Bashkir', Bc: 'Baluchi', Be: 'Belarusian',
  Bg: 'Bulgarian', Bh: 'Bhili', Bi: 'Bislama', Bj: 'Banjari',
  Bk: 'Bambara', Bl: 'Balinese', Bm: 'Bambara', Bn: 'Bengali',
  Bo: 'Bosnian', Br: 'Burmese', Bs: 'Bosnian', Bt: 'Beti',
  Bu: 'Burmese', By: 'Buryat',
  C: 'Chinese (Mandarin)', Ca: 'Catalan', Cb: 'Cebuano', Cc: 'Chechen',
  Cd: 'Choctaw', Ce: 'Cebuano', Cg: 'Chittagonian', Ch: 'Chin',
  Ci: 'Chichewa', Ck: 'Cherokee', Cm: 'Mandarin Chinese',
  Cn: 'Cantonese', Co: 'Comorian', Cr: 'Creole', Cs: 'Czech',
  Cu: 'Chuvash', Cw: 'Chuvash', Cz: 'Czech',
  D: 'German', Da: 'Danish', Dh: 'Dhivehi', Di: 'Dinka',
  Dr: 'Dari (Persian)', Du: 'Dutch', Dz: 'Dzongkha',
  E: 'English', Ed: 'Edo', Es: 'Estonian', Eo: 'Esperanto',
  Eu: 'Basque', Ev: 'Evenki', Ew: 'Ewe', Eg: 'Egyptian Arabic',
  F: 'French', Fa: 'Persian (Farsi)', Fi: 'Finnish',
  Fj: 'Fijian', Fl: 'Filipino', Fn: 'Fon', Fr: 'French',
  Fs: 'Faroese', Fu: 'Fulani', Fz: 'Fanti',
  G: 'German', Ga: 'Garhwali', Gd: 'Scottish Gaelic',
  Ge: 'Georgian', Gj: 'Gujarati', Gn: 'Guarani',
  Gp: 'Greek (modern)', Gr: 'Greek', Gu: 'Gujarati', Gw: 'Garhwali',
  H: 'Hindi', Ha: 'Hausa', Hb: 'Hebrew', He: 'Hebrew',
  Hi: 'Hindi', Hk: 'Hakka', Hm: 'Hmong', Hn: 'Hindi',
  Ho: 'Hopi', Hr: 'Croatian', Hu: 'Hungarian', Hy: 'Armenian',
  I: 'Italian', Ia: 'Interlingua', Ib: 'Igbo', If: 'Iranian Farsi',
  Ig: 'Igbo', Ii: 'Ilocano', In: 'Indonesian', Io: 'Ido',
  Is: 'Icelandic', It: 'Italian', Iu: 'Inuktitut',
  J: 'Japanese', Jp: 'Japanese', Jv: 'Javanese',
  K: 'Korean', Ka: 'Kannada', Kb: 'Karbi', Kc: 'Karen',
  Kd: 'Kurdish', Ke: 'Kekchi', Kg: 'Kongo', Kh: 'Khmer',
  Ki: 'Kikuyu', Kj: 'Kachin', Kk: 'Kazakh', Kl: 'Kalenjin',
  Km: 'Khmer', Kn: 'Kannada', Ko: 'Korean', Kr: 'Kurdish',
  Ks: 'Kashmiri', Kt: 'Karen', Ku: 'Kurdish', Kv: 'Kalmyk',
  Kw: 'Kawi', Kx: 'Kashubian', Ky: 'Kyrgyz', Kz: 'Kazakh',
  L: 'Lao', La: 'Latin', Lb: 'Lhomi', Lh: 'Lhasa Tibetan',
  Li: 'Lingala', Lk: 'Lakota', Ll: 'Lao', Lo: 'Lao',
  Lt: 'Lithuanian', Lv: 'Latvian',
  M: 'Mandarin Chinese', Ma: 'Malay', Mc: 'Macedonian',
  Md: 'Mende', Me: 'Meitei', Mg: 'Malagasy', Mh: 'Maharashtri',
  Mi: 'Mien', Mj: 'Maithili', Mk: 'Macedonian', Ml: 'Malayalam',
  Mm: 'Maithili', Mn: 'Mongolian', Mo: 'Mongolian', Mp: 'Mapuche',
  Mq: 'Maquiritari', Mr: 'Marathi', Ms: 'Malay', Mt: 'Maltese',
  Mu: 'Mundari', My: 'Burmese', Mz: 'Mizo',
  N: 'Norwegian', Na: 'Naga', Nd: 'Ndebele', Ne: 'Nepali',
  Ng: 'Ngambay', Ni: 'Nias', Nj: 'Ndogo', Nl: 'Dutch',
  Nn: 'Nepali', No: 'Norwegian', Np: 'Nepali', Ns: 'Nuer',
  Nu: 'Nuer', Nv: 'Navajo', Ny: 'Nyanja',
  O: 'Oromo', Oj: 'Ojibwe', Om: 'Oromo', On: 'Oriya',
  Or: 'Oriya', Os: 'Ossetic',
  P: 'Portuguese', Pa: 'Pashto', Pe: 'Persian (Farsi)',
  Pj: 'Punjabi', Pl: 'Polish', Pn: 'Punjabi', Po: 'Portuguese',
  Pp: 'Papiamento', Pr: 'Persian (Farsi)', Ps: 'Pashto',
  Pt: 'Portuguese', Pu: 'Punjabi', Px: 'Pashto',
  Q: 'Quechua', Qu: 'Quechua',
  R: 'Russian', Re: 'Rendille', Rh: 'Romansh', Rj: 'Rajasthani',
  Rm: 'Romanian', Ro: 'Romanian', Ru: 'Russian', Rw: 'Kinyarwanda',
  S: 'Spanish', Sa: 'Sango', Sb: 'Serbian', Sc: 'Scots Gaelic',
  Sd: 'Sindhi', Se: 'Sesotho', Sg: 'Songhay', Sh: 'Shona',
  Si: 'Sinhala', Sk: 'Slovak', Sl: 'Slovenian', Sm: 'Samoan',
  Sn: 'Sindhi', So: 'Somali', Sp: 'Spanish', Sq: 'Albanian',
  Sr: 'Serbian', Ss: 'Sesotho', St: 'Sotho', Su: 'Sundanese',
  Sv: 'Swahili', Sw: 'Swahili', Swe: 'Swedish', Sx: 'Saxon',
  Sy: 'Syriac', Sz: 'Swazi',
  T: 'Turkish', Ta: 'Tamil', Tb: 'Tibetan', Tc: 'Turkmen',
  Td: 'Tedim Chin', Te: 'Telugu', Tg: 'Tigrinya', Th: 'Thai',
  Ti: 'Tigrinya', Tj: 'Tajik', Tk: 'Turkmen', Tl: 'Tagalog',
  Tm: 'Tamil', Tn: 'Tonga', To: 'Tongan', Tr: 'Turkish',
  Ts: 'Tswana', Tt: 'Tatar', Tu: 'Turkish', Tv: 'Tuvan',
  Tw: 'Taiwanese', Tz: 'Tzotzil',
  U: 'Ukrainian', Uk: 'Ukrainian', Ur: 'Urdu', Uy: 'Uyghur',
  Uz: 'Uzbek',
  V: 'Vietnamese', Vi: 'Vietnamese', Vn: 'Vietnamese',
  W: 'Welsh', Wo: 'Wolof', Wu: 'Wu Chinese',
  X: 'Xhosa', Xh: 'Xhosa',
  Y: 'Yiddish', Yi: 'Yiddish', Yo: 'Yoruba',
  Z: 'Zulu', Zh: 'Mandarin Chinese', Zu: 'Zulu',
};

const TARGET: Record<string, string> = {
  Af: 'Africa', NAf: 'North Africa', WAf: 'West Africa',
  EAf: 'East Africa', CAf: 'Central Africa', SAf: 'Southern Africa',
  As: 'Asia', CAs: 'Central Asia', EAs: 'East Asia',
  SAs: 'South Asia', SEAs: 'Southeast Asia', NEAs: 'Northeast Asia',
  WAs: 'West Asia',
  ME: 'Middle East', NME: 'Northern Middle East',
  Eu: 'Europe', WEu: 'Western Europe', EEu: 'Eastern Europe',
  CEu: 'Central Europe', SEu: 'Southern Europe', NEu: 'Northern Europe',
  Am: 'Americas', NAm: 'North America', CAm: 'Central America',
  SAm: 'South America', LAm: 'Latin America',
  Carb: 'Caribbean', WIn: 'West Indies',
  Oc: 'Oceania', Pac: 'Pacific', Au: 'Australasia',
  WW: 'Worldwide', WNW: 'Worldwide (network)', C: 'clandestine',
  Eth: 'Ethiopia', Som: 'Somalia', Sud: 'Sudan',
  Iran: 'Iran', Irq: 'Iraq', Syr: 'Syria', Tib: 'Tibet',
  Cu: 'Cuba', Bz: 'Brazil',
};

const COUNTRY: Record<string, string> = {
  AFG: 'Afghanistan', ALG: 'Algeria', ALB: 'Albania', AND: 'Andorra',
  ANG: 'Angola', ARG: 'Argentina', ARM: 'Armenia', ARS: 'Saudi Arabia',
  ASC: 'Ascension Island', AUS: 'Australia', AUT: 'Austria',
  AZE: 'Azerbaijan',
  B: 'Brazil', BAH: 'Bahamas', BEL: 'Belgium', BGD: 'Bangladesh',
  BLR: 'Belarus', BOL: 'Bolivia', BOT: 'Botswana', BRB: 'Barbados',
  BRU: 'Brunei', BTN: 'Bhutan', BUL: 'Bulgaria', BUR: 'Myanmar',
  CAN: 'Canada', CHL: 'Chile', CHN: 'China', CLM: 'Colombia',
  CLN: 'Sri Lanka', CME: 'Cameroon', COG: 'Congo', COL: 'Colombia',
  CTI: "Côte d'Ivoire", CUB: 'Cuba', CVA: 'Vatican City', CYP: 'Cyprus',
  CZE: 'Czech Republic',
  D: 'Germany', DEN: 'Denmark', DJI: 'Djibouti', DOM: 'Dominican Rep.',
  E: 'Spain', EGY: 'Egypt', EQA: 'Ecuador', ERI: 'Eritrea',
  EST: 'Estonia', ETH: 'Ethiopia',
  F: 'France', FIN: 'Finland', FJI: 'Fiji',
  G: 'United Kingdom', GAB: 'Gabon', GEO: 'Georgia', GHA: 'Ghana',
  GNE: 'Equatorial Guinea', GRC: 'Greece', GTM: 'Guatemala', GUF: 'Guyana',
  GUI: 'Guinea', GUM: 'Guam',
  HKG: 'Hong Kong', HND: 'Honduras', HOL: 'Netherlands', HRV: 'Croatia',
  HNG: 'Hungary',
  I: 'Italy', IND: 'India', INS: 'Indonesia', IRL: 'Ireland',
  IRN: 'Iran', IRQ: 'Iraq', ISL: 'Iceland', ISR: 'Israel',
  J: 'Japan', JOR: 'Jordan',
  KAZ: 'Kazakhstan', KEN: 'Kenya', KGZ: 'Kyrgyzstan',
  KOR: 'South Korea', KRE: 'North Korea', KSA: 'Saudi Arabia',
  KWT: 'Kuwait',
  LAO: 'Laos', LBN: 'Lebanon', LBR: 'Liberia', LBY: 'Libya',
  LCA: 'Saint Lucia', LSO: 'Lesotho', LTU: 'Lithuania',
  LUX: 'Luxembourg', LVA: 'Latvia',
  MAR: 'Morocco', MAU: 'Mauritius', MCO: 'Monaco', MDA: 'Moldova',
  MDG: 'Madagascar', MEX: 'Mexico', MKD: 'North Macedonia',
  MLA: 'Malaysia', MLI: 'Mali', MLT: 'Malta', MNE: 'Montenegro',
  MNG: 'Mongolia', MOZ: 'Mozambique', MRA: 'Northern Mariana Is.',
  MTN: 'Mauritania',
  NCG: 'Nicaragua', NEP: 'Nepal', NGR: 'Niger', NIG: 'Nigeria',
  NMB: 'Namibia', NOR: 'Norway', NZL: 'New Zealand',
  OMA: 'Oman',
  PAK: 'Pakistan', PHL: 'Philippines', PNG: 'Papua New Guinea',
  POL: 'Poland', POR: 'Portugal', PRG: 'Paraguay', PRU: 'Peru',
  PTR: 'Puerto Rico',
  QAT: 'Qatar',
  ROM: 'Romania', ROU: 'Romania', RRW: 'Rwanda', RUS: 'Russia',
  S: 'Sweden', SDN: 'Sudan', SEN: 'Senegal', SEY: 'Seychelles',
  SGP: 'Singapore', SLM: 'Solomon Islands', SLV: 'El Salvador',
  SMA: 'San Marino', SMO: 'Samoa', SNG: 'Singapore', SOM: 'Somalia',
  SRB: 'Serbia', SRL: 'Sierra Leone', SSD: 'South Sudan',
  STP: 'São Tomé', SUI: 'Switzerland', SVK: 'Slovakia', SVN: 'Slovenia',
  SWZ: 'Eswatini', SYR: 'Syria',
  TCH: 'Chad', TGO: 'Togo', THA: 'Thailand', TJK: 'Tajikistan',
  TKM: 'Turkmenistan', TON: 'Tonga', TUN: 'Tunisia', TUR: 'Turkey',
  TWN: 'Taiwan',
  UAE: 'United Arab Emirates', UGA: 'Uganda', UKR: 'Ukraine',
  URG: 'Uruguay', USA: 'United States', UZB: 'Uzbekistan',
  VEN: 'Venezuela', VTN: 'Vietnam', VUT: 'Vanuatu',
  YEM: 'Yemen',
  ZMB: 'Zambia', ZWE: 'Zimbabwe',
};

/** TX-site prefix lookups. The full code is usually "PREFIX-MODE"
 *  (mode = A for AM, D for DRM, S for SW), so we strip the trailing
 *  "-X" and try to map the prefix. Site names are city / station. */
const TX_SITE: Record<string, string> = {
  ABE: 'Abu Dhabi, UAE', AGI: 'Agignan, Madagascar', AGN: 'Argenton, France',
  AJI: 'Ajion, Greece', ALM: 'Almaty, Kazakhstan', ALT: 'Altyn-Tepe, Tajikistan',
  ALV: 'Alvajärvi, Finland', AMM: 'Amman, Jordan', ANC: 'Ancón, Peru',
  ANG: 'Aogashima, Japan', ANK: 'Ankara, Turkey', ARG: 'Argentina',
  ARM: 'Armavir, Russia', ARS: 'Asunción, Paraguay', ASC: 'Ascension Island',
  ATL: 'Atlanta, USA', AYS: 'Asyut, Egypt',
  BAB: 'Babcock UK', BAK: 'Baku, Azerbaijan', BAM: 'Bamako, Mali',
  BAR: 'Bareilly, India', BAT: 'Bata, Eq. Guinea', BBC: 'BBC World Service',
  BEI: 'Beijing, China', BEL: 'Belgrade, Serbia', BEN: 'Benghazi, Libya',
  BIB: 'Biblis, Germany', BJG: 'Beijing, China', BJM: 'Bujumbura, Burundi',
  BLB: 'Bishkek, Kyrgyzstan', BMA: 'Bocaranga, CAR', BMD: 'Bermuda',
  BON: 'Bonaire (defunct)', BUD: 'Budapest, Hungary', BUE: 'Buenos Aires, Argentina',
  CAI: 'Cairo, Egypt', CAR: 'Carnarvon, Australia', CHA: 'Chatti Indi, Iran',
  CHI: 'Chicago, USA', CLT: 'Calgary, Canada', COL: 'Colombo, Sri Lanka',
  CRI: 'China Radio International', CYC: 'Cyclops, Malta',
  DAR: 'Dar es Salaam, Tanzania', DEL: 'Delhi, India', DHA: 'Dhabbaya, UAE',
  DHB: 'Dhabbaya, UAE', DLA: 'Dilang, Vanuatu', DOI: 'Doha, Qatar',
  DRM: 'Dushanbe, Tajikistan', DSH: 'Dushanbe, Tajikistan',
  EME: 'Emirler, Turkey', ENC: 'Encompass UK', ERV: 'Yerevan-Gavar, Armenia',
  ESS: 'Essex, UK',
  FET: 'Fethiye, Turkey', FLO: 'Florida, USA',
  GAR: 'Gardabani, Georgia', GAV: 'Gavar (Yerevan), Armenia', GBA: 'Gabon',
  GED: 'Gedser, Denmark', GFP: 'Gosport, UK', GLO: 'Globecast',
  GRE: 'Greenville, USA',
  HAB: 'Habana, Cuba', HAN: 'Hanoi, Vietnam', HBN: 'Habana, Cuba',
  HEL: 'Helsinki, Finland', HOL: 'Holzkirchen, Germany',
  HRI: 'Khabarovsk, Russia', HRT: 'Hartlepool, UK',
  IBB: 'Int. Broadcasting Bureau', IBR: 'Ibaraki, Japan',
  IRA: 'IRRS Italy', IRR: 'IRRS Italy', ISS: 'Issoudun, France',
  IST: 'Istanbul, Turkey',
  JAW: 'Jaworze, Poland', JEM: 'Jemen / Yemen', JER: 'Jerusalem, Israel',
  JLN: 'Jelantse, China', JOR: 'Jordan', JUL: 'Jülich, Germany',
  KAB: 'Kabul, Afghanistan', KAJ: 'Kajang, Malaysia',
  KAS: 'Kashgar, China', KCH: 'Kashgar, China', KEL: 'Kelang, Malaysia',
  KIG: 'Kigali, Rwanda', KIM: 'Kimchaek, North Korea',
  KKR: 'Kashi, China', KOH: 'Kohima, India',
  KRA: 'Krasnodar, Russia', KRN: 'Krasnoyarsk, Russia',
  KSH: 'Kashgar, China', KUN: 'Kunming, China', KUR: 'Kuwait',
  KUS: 'Kashi, China', KWT: 'Kuwait',
  LAM: 'Lamphun, Thailand', LAO: 'Laos', LAU: 'Lausanne, Switzerland',
  LIM: 'Limassol, Cyprus', LIS: 'Lisbon, Portugal', LSB: 'Lisbon, Portugal',
  LUS: 'Lusaka, Zambia', LXM: 'Luxembourg',
  MAD: 'Madagascar', MAH: 'Mahe, Seychelles', MAN: 'Manila, Philippines',
  MBR: 'Moosbrunn, Austria', MCS: 'Moosbrunn, Austria',
  MEY: 'Meyerton, South Africa', MIA: 'Miami, USA', MNL: 'Manila, Philippines',
  MOS: 'Moscow, Russia', MOY: 'Moyabi, Gabon', MTC: 'Montecarlo, Monaco',
  MUS: 'Mussisaari, Finland',
  NAU: 'Nauen, Germany', NIA: 'Niamey, Niger', NOV: 'Novosibirsk, Russia',
  OKE: 'Okeechobee, USA', OSL: 'Oslo, Norway',
  PAL: 'Palauig, Philippines', PER: 'Perth, Australia',
  PET: 'Petropavlovsk, Russia', PHI: 'Philippines', PIN: 'Pinheira, Brazil',
  PNF: 'Pinheiros, Brazil', POL: 'Poland', PUG: 'Pugachev, Russia',
  PUL: 'Pulaski, USA',
  RAS: 'Riyadh AM Saudi Arabia', RBT: 'Rabat, Morocco', REL: 'Reling, Indonesia',
  RIO: 'Rio de Janeiro, Brazil', RIY: 'Riyadh, Saudi Arabia',
  RKW: 'Reykjavik, Iceland', RVI: 'Rome (Vatican)', RYD: 'Riyadh, Saudi Arabia',
  SAI: 'Saipan, USA', SAM: 'Samara, Russia', SAO: 'São Paulo, Brazil',
  SCB: 'Sao Tome', SEL: 'Selibi-Phikwe, Botswana', SEN: 'Sentmenat, Spain',
  SHE: 'Shepparton, Australia', SHK: 'Sharjah, UAE',
  SIN: 'Singapore', SIT: 'Sitkunai, Lithuania', SKA: 'Skelton, UK',
  SLM: 'Salyut, Russia', SOF: 'Sofia, Bulgaria', SPC: 'Spaceline', SRI: 'Sri Lanka',
  TAC: 'Taichung, Taiwan', TAI: 'Taipei, Taiwan', TAM: 'Tamshui, Taiwan',
  TAO: 'Taoyuan, Taiwan', TAS: 'Tashkent, Uzbekistan',
  TAV: 'Tavolara, Italy', TCH: 'Chad', TEH: 'Tehran, Iran',
  THA: 'Thailand', THM: 'Thmar Puok, Cambodia', TIN: 'Tinian, Mariana Is.',
  TIR: 'Tirana, Albania', TKY: 'Tokyo, Japan', TLL: 'Tallinn, Estonia',
  TOK: 'Tokyo, Japan', TOM: 'Tomsk, Russia',
  TRM: 'Trincomalee, Sri Lanka', TWR: 'Trans World Radio',
  UBA: 'Ulaanbaatar, Mongolia', ULB: 'Ulaanbaatar, Mongolia',
  URM: 'Urumqi, China', VAK: 'Vakhsh, Tajikistan',
  VAR: 'Varberg, Sweden', VAT: 'Vatican (SMG)', VLA: 'Vladivostok, Russia',
  VLD: 'Vladivostok, Russia', VOA: 'Voice of America',
  VTC: 'Vatican (SMG)',
  WCB: 'WCBS / USA', WER: 'Wertachtal, Germany', WHR: 'WHRI Cypress Creek, USA',
  WHRA: 'WHRI', WIN: 'Wingst, Germany', WMB: 'Wembley, UK',
  WOF: 'Woofferton, UK', WTW: 'WTWW, USA', WWC: 'WWCR Nashville, USA',
  XIN: 'Xian, China', YAM: 'Yamata, Japan', YAR: 'Yarbo, Pakistan',
  YER: 'Yerevan, Armenia', YIM: 'Yamata, Japan',
  ZAH: 'Zahedan, Iran',
};

function spaced(code: string): string {
  // Split EIBI codes on comma to handle composites like "E,F" → "English / French".
  return code
    .split(/[,/]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => LANGUAGE[s] ?? s)
    .join(' / ');
}

export function eibiLanguage(code: string): string {
  if (!code) return '';
  return spaced(code);
}

export function eibiTarget(code: string): string {
  if (!code) return '';
  return code
    .split(/[,/]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => TARGET[s] ?? s)
    .join(' / ');
}

export function eibiCountry(code: string): string {
  if (!code) return '';
  return COUNTRY[code.trim()] ?? code;
}

/** Translate a TX-site code. Format is usually "PREFIX-MODE" (e.g.
 *  "NAU-A", "WOF-D"). We strip "-MODE" before lookup and re-append a
 *  human-readable mode tag if recognised. */
export function eibiTxSite(code: string): string {
  if (!code) return '';
  const t = code.trim();
  const m = /^([A-Za-z0-9]+)-([A-Za-z0-9]+)$/.exec(t);
  if (!m) return TX_SITE[t] ?? t;
  const [, prefix, suffix] = m;
  const site = TX_SITE[prefix] ?? prefix;
  // Common transmitter-type suffixes used by EIBI.
  const typeMap: Record<string, string> = {
    A: 'AM', D: 'DRM', S: 'SW', F: 'FM', U: 'USB', L: 'LSB',
  };
  const type = typeMap[suffix] ?? suffix;
  return `${site} [${type}]`;
}
