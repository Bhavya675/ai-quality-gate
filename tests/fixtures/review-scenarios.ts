export interface ReviewScenario {
  id: string;
  name: string;
  expectedVerdict: "PASS" | "FAIL";
  filePath: string;
  code: string;
  reviewInstruction: string;
}

export const reviewScenarios: ReviewScenario[] = [
  {
    id: "clean-code",
    name: "Clean code",
    expectedVerdict: "PASS",
    filePath: "src/calculator.ts",
    code: `
export function add(a: number, b: number): number {
  return a + b;
}
`,
    reviewInstruction:
      "This is intentionally clean code. Check for genuine defects, not optional improvements.",
  },
  {
    id: "sql-injection",
    name: "SQL injection vulnerability",
    expectedVerdict: "FAIL",
    filePath: "src/repositories/user-repository.ts",
    code: `
export async function getUser(db: any, userId: string) {
  const query = "SELECT * FROM users WHERE id = '" + userId + "'";
  return db.query(query);
}
`,
    reviewInstruction:
      "Check specifically whether untrusted user input is safely handled when constructing the SQL query.",
  },
  {
    id: "data-loss",
    name: "Unrestricted data deletion",
    expectedVerdict: "FAIL",
    filePath: "src/repositories/employee-repository.ts",
    code: `
export async function deleteEmployee(db: any, employeeId: number) {
  await db.query("DELETE FROM employees");
}
`,
    reviewInstruction:
      "Check specifically whether the operation can delete unintended employee records instead of only the requested employee.",
  },
];
