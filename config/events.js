export const EVENTS = {
  BGMI: {
    sheetName: "BGMI",
    verificationChannelId: "1495404999709298689",
    backupChannelId: "1495405114943602848",
    roleId: "1495975013566644335",
    isTeamEvent: true,
    displayName: "BGMI Verification",
    description:
      "Click below to open a Team Verification ticket.\n\n- Only the Team Captain needs to open a ticket and share details for all players.\n- Make sure your Discord is updated to the latest version.",
  },
  Chess: {
    sheetName: "Chess",
    verificationChannelId: "1495405009263792263",
    backupChannelId: "1495405116071874694",
    roleId: "1495975158211674253",
    isTeamEvent: false,
    displayName: "Chess Verification",
    description:
      "Click below to open a Player Verification ticket.\n\n- Make sure your Discord is updated to the latest version.",
  },
  EFM: {
    sheetName: "EFM",
    verificationChannelId: "1495405021976596641",
    backupChannelId: "1495405123445199059",
    roleId: "1495975230336794735",
    isTeamEvent: false,
    displayName: "E-Football Mobile Verification",
    description:
      "Click below to open a Player Verification ticket.\n\n- Make sure your Discord is updated to the latest version.",
  },
  FC26: {
    sheetName: "FC26",
    verificationChannelId: "1495405015395729460",
    backupChannelId: "1495405118852435968",
    roleId: "1495975479877046322",
    isTeamEvent: false,
    displayName: "FC 26 Verification",
    description:
      "Click below to open a Player Verification ticket.\n\n- Make sure your Discord is updated to the latest version.",
  },
  SF6: {
    sheetName: "STREET FIGHTER 6",
    verificationChannelId: "1495405028087824465",
    backupChannelId: "1495405120069042196",
    roleId: "1495975719996489828",
    isTeamEvent: false,
    displayName: "Street Fighter 6 Verification",
    description:
      "Click below to open a Player Verification ticket.\n\n- Make sure your Discord is updated to the latest version.",
  },
};


// Quick lookup by verification channel ID (used by admin commands)
export function getEventByChannelId(channelId) {
  return Object.entries(EVENTS).find(
    ([, details]) => details.verificationChannelId === channelId,
  );
}
