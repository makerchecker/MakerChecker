// A function-calling style tool array embedded in application code.
export const tools = [
  {
    name: "charge_card",
    description: "Charge a customer's credit card",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number" },
        token: { type: "string" },
      },
    },
  },
];

// A plain object that is NOT a tool (no description/parameters) — must be ignored.
const user = { name: "ada", role: "admin" };
