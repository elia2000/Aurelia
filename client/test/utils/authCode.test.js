import { describe, expect, test } from "vitest";
import { splitAuthCode } from "../../src/utils/authCode.js";
import { groupSecret, methodLabel } from "../../src/utils/sessionLabels.js";

describe("splitAuthCode", () => {
  test("six digits (with or without a space) are an authenticator code", () => {
    expect(splitAuthCode("123456")).toEqual({ code: "123456" });
    expect(splitAuthCode(" 123 456 ")).toEqual({ code: "123456" });
  });
  test("anything else is read as a recovery code", () => {
    expect(splitAuthCode("ABCDE-FGHJK")).toEqual({ recoveryCode: "ABCDE-FGHJK" });
    expect(splitAuthCode("12345")).toEqual({ recoveryCode: "12345" });
  });
  test("nothing typed sends nothing", () => {
    expect(splitAuthCode("")).toEqual({});
    expect(splitAuthCode(undefined)).toEqual({});
  });
});

describe("sessionLabels", () => {
  test("groupSecret spaces the key in fours", () => {
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    expect(groupSecret("jbsw y3dp")).toBe("jbsw y3dp");
    expect(groupSecret(null)).toBe("");
  });
  test("methodLabel says how a session was made", () => {
    expect(methodLabel({ method: "password" })).toMatch(/password/);
    expect(methodLabel({ method: "password_2fa" })).toMatch(/code/);
    expect(methodLabel({ method: "recovery_code" })).toMatch(/recovery/);
    expect(methodLabel({ method: "registration" })).toMatch(/created/);
    expect(methodLabel({ method: null })).toBe("");
  });
});
