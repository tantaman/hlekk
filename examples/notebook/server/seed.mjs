// Stable keys let the first-run notebook finish initializing after an interrupted start.
export const sampleDocs = [
  ["noticing", "The art of noticing", "Observations"],
  ["attention", "Attention as a practice", "Ideas"],
  ["walks", "Walking as research", "Observations"],
  ["garden", "A garden of ideas", "Ideas"],
  ["reading", "Reading notes", "Reading list"],
];
const text = (text, marks) => ({ type: "text", text, ...(marks ? { marks } : {}) });
const wiki = (label) => ({ type: "wiki", attrs: { label } });
export const seedBodies = {
  noticing: [
    [
      "paragraph",
      text(
        "I took the long way home today. Same streets, different pace. Somewhere between the corner shop and the old oak, I started seeing things I usually walk straight past.",
      ),
    ],
    ["heading", text("Small observations")],
    ["bullet", text("A fern growing out of the mortar, exactly where the afternoon light lands.")],
    ["bullet", text("The worn edge of a stone step. A record of thousands of small decisions.")],
    ["bullet", text("How a familiar street feels entirely new when you look up.")],
    ["quote", text("Perhaps attention is less about looking harder and more about staying a little longer.")],
    [
      "paragraph",
      text("This feels connected to "),
      wiki("Attention as a practice"),
      text(" and the notes I’ve been keeping on "),
      wiki("Walking as research"),
      text("."),
    ],
  ],
  attention: [
    [
      "paragraph",
      text(
        "Attention is something I can return to. Picking one small detail each morning makes the practice easier to keep.",
      ),
    ],
  ],
  walks: [
    [
      "paragraph",
      text("A walk gives a question time to change shape. I started collecting examples in "),
      wiki("The art of noticing"),
      text("."),
    ],
  ],
  garden: [
    [
      "paragraph",
      text("Some ideas need room between visits. "),
      wiki("The art of noticing"),
      text(" is one I keep coming back to."),
    ],
  ],
  reading: [["paragraph", text("A place for passages and questions I want to revisit.")]],
};
