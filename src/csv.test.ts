import test from "node:test";
import assert from "node:assert/strict";
import { csv } from "./csv.js";

test("CSV output quotes cells and neutralizes spreadsheet formulas", () => {
  assert.equal(
    csv([["email", "name"], ["person@example.com", 'A "quoted" name'], ["=1+1", "  @SUM(A1:A2)"]]),
    '"email","name"\r\n"person@example.com","A ""quoted"" name"\r\n"\'=1+1","\'  @SUM(A1:A2)"\r\n',
  );
});
