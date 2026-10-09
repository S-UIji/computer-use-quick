/** Approved v3 mascot: 24px, four colors, mirrored about the vertical axis.
 * Kept in the bundle so browser overlays never depend on image URLs or files.
 */
const HALF = [
  "............",
  "............",
  "............",
  ".....BB.....",
  "....BBBB....",
  "....BIIBB...",
  "....BIWBBB..",
  "....BBBBBBBB",
  "...BBBWWWWBB",
  "...BBWWWWWBB",
  "...BBWWWNWWB",
  "...BWWWWNWWW",
  "...BWWWWWWWN",
  "....BWWWWWWW",
  "....BBWWWWWW",
  ".....BBWWWWW",
  ".....BBBWWWW",
  ".....BBBBBBB",
  "......BBBB..",
  "......BBBB..",
  "............",
  "............",
  "............",
  "............"
];

const PALETTE = { B: "#79A6DE", W: "#F4F8FF", I: "#BCD6F2", N: "#29394F" };
const rows = HALF.map((half) => half + [...half].reverse().join(""));

// A white underlay keeps blinking eyes opaque instead of exposing the badge.
const background = rows.map((row, y) => [...row].map((pixel, x) =>
  (x === 8 || x === 15) && (y === 10 || y === 11) ? "W" : pixel
));

export const PIXEL_FOX = {
  size: 24,
  paths: Object.entries(PALETTE).map(([key, fill]) => {
    let d = "";
    for (let y = 0; y < background.length; y++) {
      for (let x = 0; x < background[y].length;) {
        if (background[y][x] !== key) { x++; continue; }
        const start = x;
        while (background[y][x] === key) x++;
        d += `M${start} ${y}h${x - start}v1H${start}z`;
      }
    }
    return { fill, d };
  }),
  ink: PALETTE.N,
  eyes: {
    open: "M8 10h1v2H8zM15 10h1v2H15z",
    closed: "M7 11h2v1H7zM15 11h2v1H15z",
    alert: "M8 9h1v3H8zM15 9h1v3H15z"
  }
};
