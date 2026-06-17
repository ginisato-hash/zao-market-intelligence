import { describe, expect, it } from "vitest";
import {
  classifyRoomBasis,
  classifyRoomBasisFromParts,
  isTwoPersonStandardRoom,
  normalizeRoomText,
  roomBasisDpExclusionReason
} from "../src/services/roomBasisClassification";

describe("room-basis classification — accepted two-person standard rooms", () => {
  for (const text of [
    "ツイン", "ダブル", "洋室ツイン", "洋室ダブル",
    "Twin Room", "Double Room", "Queen Room", "King Room",
    "2 beds", "Two Beds", "1 Queen", "1 King"
  ]) {
    it(`${text} => confirmed_two_person_standard_room`, () => {
      const c = classifyRoomBasis(text);
      expect(c.roomBasis, text).toBe("confirmed_two_person_standard_room");
      expect(c.roomBasisConfidence).toBe("high");
      expect(isTwoPersonStandardRoom(c)).toBe(true);
    });
  }
});

describe("room-basis classification — single rooms", () => {
  for (const text of ["シングル", "Single Room", "1名", "１名", "1 person", "one person"]) {
    it(`${text} => excluded_single_room`, () => {
      expect(classifyRoomBasis(text).roomBasis, text).toBe("excluded_single_room");
    });
  }
});

describe("room-basis classification — semi-double rooms", () => {
  for (const text of ["セミダブル", "Semi Double", "semi-double", "semidouble", "small double"]) {
    it(`${text} => excluded_semi_double_room`, () => {
      expect(classifyRoomBasis(text).roomBasis, text).toBe("excluded_semi_double_room");
    });
  }
});

describe("room-basis classification — large / triple / quad rooms", () => {
  for (const text of ["トリプル", "Triple Room", "3名", "３名", "4名", "大部屋", "和室12畳", "和室１２畳", "quad"]) {
    it(`${text} => excluded_large_room`, () => {
      expect(classifyRoomBasis(text).roomBasis, text).toBe("excluded_large_room");
    });
  }
});

describe("room-basis classification — family / suite rooms", () => {
  for (const text of ["ファミリー", "Family Room", "スイート", "Suite", "特別室", "junior suite"]) {
    it(`${text} => excluded_family_or_suite_room`, () => {
      expect(classifyRoomBasis(text).roomBasis, text).toBe("excluded_family_or_suite_room");
    });
  }
});

describe("room-basis classification — conflict handling (exclusion wins)", () => {
  it("ツイン スイート => excluded_family_or_suite_room", () => {
    expect(classifyRoomBasis("ツイン スイート").roomBasis).toBe("excluded_family_or_suite_room");
  });
  it("ダブル 3名 => excluded_large_room", () => {
    expect(classifyRoomBasis("ダブル 3名").roomBasis).toBe("excluded_large_room");
  });
  it("ツイン 3名 => excluded_large_room", () => {
    expect(classifyRoomBasis("ツイン 3名").roomBasis).toBe("excluded_large_room");
  });
  it("small double (accepted 'double' substring) => excluded_semi_double_room", () => {
    expect(classifyRoomBasis("small double").roomBasis).toBe("excluded_semi_double_room");
  });
});

describe("room-basis classification — unknown", () => {
  for (const text of ["シンプルステイ", "おまかせ", "スタンダードプラン", ""]) {
    it(`${JSON.stringify(text)} => unknown_room_basis (low)`, () => {
      const c = classifyRoomBasis(text);
      expect(c.roomBasis, text).toBe("unknown_room_basis");
      expect(c.roomBasisConfidence).toBe("low");
      expect(isTwoPersonStandardRoom(c)).toBe(false);
    });
  }
});

describe("room-basis classification — helpers", () => {
  it("normalizeRoomText folds width and case and collapses spaces", () => {
    expect(normalizeRoomText("Ｔｗｉｎ　 Room")).toBe("twin room");
    expect(normalizeRoomText("３名")).toBe("3名");
  });

  it("classifyRoomBasisFromParts joins room/plan/rate text", () => {
    expect(classifyRoomBasisFromParts({ roomName: "スタンダードツイン", planName: "素泊まり" }).roomBasis)
      .toBe("confirmed_two_person_standard_room");
    expect(classifyRoomBasisFromParts({ roomName: "", planName: "シングル利用" }).roomBasis)
      .toBe("excluded_single_room");
    expect(classifyRoomBasisFromParts({}).roomBasis).toBe("unknown_room_basis");
  });

  it("roomBasisDpExclusionReason maps each excluded basis", () => {
    expect(roomBasisDpExclusionReason("confirmed_two_person_standard_room")).toBeNull();
    expect(roomBasisDpExclusionReason("excluded_single_room")).toBe("excluded_room_type_single");
    expect(roomBasisDpExclusionReason("excluded_semi_double_room")).toBe("excluded_room_type_semi_double");
    expect(roomBasisDpExclusionReason("excluded_large_room")).toBe("excluded_room_type_large");
    expect(roomBasisDpExclusionReason("excluded_family_or_suite_room")).toBe("excluded_room_type_family_or_suite");
    expect(roomBasisDpExclusionReason("unknown_room_basis")).toBe("unknown_room_basis_excluded");
  });
});
