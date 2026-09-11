export const Type = { Object: (p) => ({ type: "object", properties: p }), String: (o) => ({ type: "string", ...o }) };
