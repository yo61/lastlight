import { describe, it, expect } from "vitest";
import { buildPodManifest, PROMPT_FILE } from "#src/sandbox/k8s/pod.js";

describe("buildPodManifest", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "ghcr.io/nearform/lastlight-sandbox:latest",
    command: ["sh", "-c", "echo hi"], envFromSecret: "ll-x-creds",
    cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800,
    runAsUser: 10001, workspace: { kind: "emptyDir" },
  });
  it("targets the sandbox namespace and image", () => {
    expect(pod.metadata?.namespace).toBe("lastlight-sandboxes");
    expect(pod.spec?.containers[0].image).toBe("ghcr.io/nearform/lastlight-sandbox:latest");
  });
  it("never restarts and has a deadline", () => {
    expect(pod.spec?.restartPolicy).toBe("Never");
    expect(pod.spec?.activeDeadlineSeconds).toBe(1800);
  });
  it("gives the sandbox pod no service-account token", () => {
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
  });
});

describe("buildPodManifest securityContext", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "ghcr.io/yo61/lastlight-sandbox:latest",
    command: ["sh", "-c", "echo hi"], envFromSecret: "ll-x-creds",
    cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800,
    runAsUser: 10001, workspace: { kind: "emptyDir" },
  });
  it("sets a restricted-compliant pod securityContext", () => {
    expect(pod.spec?.securityContext?.runAsNonRoot).toBe(true);
    expect(pod.spec?.securityContext?.runAsUser).toBe(10001);
    expect(pod.spec?.securityContext?.fsGroup).toBe(10001);
    expect(pod.spec?.securityContext?.seccompProfile?.type).toBe("RuntimeDefault");
  });
  it("sets a restricted-compliant container securityContext", () => {
    const c = pod.spec?.containers[0];
    expect(c?.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(c?.securityContext?.capabilities?.drop).toEqual(["ALL"]);
  });
});

describe("buildPodManifest creds via envFrom", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "img", command: ["sh", "-c", "true"],
    envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
    activeDeadlineSeconds: 1800, runAsUser: 10001, workspace: { kind: "emptyDir" },
  });
  it("pulls env from the creds Secret, not inline values", () => {
    const c = pod.spec?.containers[0];
    expect(c?.envFrom).toContainEqual({ secretRef: { name: "ll-x-creds" } });
    expect(c?.env).toBeUndefined();
  });
});

describe("buildPodManifest prompt mount", () => {
  it("mounts the prompt Secret's `prompt` key as a read-only file when set", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "lastlight-sandboxes", image: "img",
      command: ["sh", "-c", "exec agentic-pi run --model m --sandbox none --no-session < " + PROMPT_FILE],
      envFromSecret: "ll-x-creds", promptSecret: "ll-x-prompt",
      cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" },
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "prompt");
    expect(vol?.secret).toMatchObject({
      secretName: "ll-x-prompt",
      items: [{ key: "prompt", path: "prompt" }],
    });
    const mount = pod.spec?.containers[0].volumeMounts?.find((m) => m.name === "prompt");
    expect(mount).toMatchObject({ mountPath: "/lastlight", readOnly: true });
  });

  it("omits the prompt volume when no promptSecret is given (runCommand path)", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "lastlight-sandboxes", image: "img",
      command: ["sh", "-c", "echo hi"], envFromSecret: "ll-x-creds",
      cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" },
    });
    expect(pod.spec?.volumes?.some((v) => v.name === "prompt")).toBe(false);
  });
});

describe("buildPodManifest workspace", () => {
  it("backs the workspace with the PVC and attaches the init clone when kind=pvc", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "pvc", claimName: "ws-acme-web-pr12" },
      initContainers: [{ name: "clone", image: "img" }],
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "workspace");
    expect(vol?.persistentVolumeClaim?.claimName).toBe("ws-acme-web-pr12");
    expect(pod.spec?.initContainers?.[0].name).toBe("clone");
  });
  it("uses emptyDir with no init when kind=emptyDir", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" },
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "workspace");
    expect(vol?.emptyDir).toBeDefined();
    expect(pod.spec?.initContainers).toBeUndefined();
  });
  it("attaches the creds Secret envFrom to the init clone container", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "pvc", claimName: "ws-acme-web-pr12" },
      initContainers: [{ name: "clone", image: "img" }],
    });
    const init = pod.spec?.initContainers?.[0];
    expect(init?.envFrom).toContainEqual({ secretRef: { name: "ll-x-creds" } });
  });
});
