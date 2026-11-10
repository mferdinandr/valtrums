import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EXPECTED = {
  welcome: ["WelcomeArch", "TicketBooth"],
  arena: ["WelcomeArch", "ScheduleBoard"],
  create: ["AssemblyArm", "ToyWrench"],
  terminal: ["CommandDesk", "SpeechBubble"],
  portfolio: ["PersonalVaultLid"],
  battle: ["VaultALid", "VaultBLid"],
};
describe("carnival page assets", () => {
  it("ships self-contained props with the named movable parts the renderer uses", () => {
    for (const [mode, requiredNodes] of Object.entries(EXPECTED)) {
      const data = readFileSync(
        join(process.cwd(), `public/models/carnival/${mode}.glb`),
      );
      expect(data.readUInt32LE(0)).toBe(0x46546c67);
      expect(data.readUInt32LE(8)).toBe(data.length);
      const gltf = JSON.parse(
        data.subarray(20, 20 + data.readUInt32LE(12)).toString(),
      );
      expect(
        gltf.buffers.every((buffer: { uri?: string }) => !buffer.uri),
      ).toBe(true);
      const names = gltf.nodes.map((node: { name?: string }) => node.name);
      expect(names).toEqual(
        expect.arrayContaining(["Island", ...requiredNodes]),
      );
      expect(
        gltf.nodes.some(
          (node: { extras?: { provenance?: string } }) =>
            node.extras?.provenance === "Original procedural installation",
        ),
      ).toBe(true);
    }
  });
  it("keeps each prop below its 650 KB transfer budget and preserves indexed geometry", () => {
    for (const mode of Object.keys(EXPECTED)) {
      const data = readFileSync(
        join(process.cwd(), `public/models/carnival/${mode}.glb`),
      );
      expect(data.length).toBeLessThan(650_000);
      const gltf = JSON.parse(
        data.subarray(20, 20 + data.readUInt32LE(12)).toString(),
      );
      expect(
        gltf.meshes.every((mesh: { primitives: { indices?: number }[] }) =>
          mesh.primitives.every((p) => typeof p.indices === "number"),
        ),
      ).toBe(true);
    }
  });
});
