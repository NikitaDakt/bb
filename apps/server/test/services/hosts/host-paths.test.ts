import { describe, expect, it } from "vitest";
import { isForwardSlashAbsoluteHostPath } from "../../../src/services/hosts/host-paths.js";

describe("isForwardSlashAbsoluteHostPath", () => {
  it("accepts POSIX absolute paths", () => {
    expect(isForwardSlashAbsoluteHostPath("/home/x")).toBe(true);
  });

  it("accepts Windows drive paths with forward slashes", () => {
    expect(isForwardSlashAbsoluteHostPath("C:/work/project")).toBe(true);
  });

  it("rejects relative paths", () => {
    expect(isForwardSlashAbsoluteHostPath("relative")).toBe(false);
  });

  it("rejects Windows paths using backslashes", () => {
    expect(isForwardSlashAbsoluteHostPath("C:\\bb\\x")).toBe(false);
  });

  it("does not collapse a drive root when trailing slashes are trimmed", () => {
    const path = "C:/";
    const normalized = path.replace(/\/+$/u, "") || "/";
    expect(normalized).toBe("C:");
  });
});
