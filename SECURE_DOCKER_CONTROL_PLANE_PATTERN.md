# Secure Docker Control Plane Pattern

This document describes a reusable architecture pattern for a service that must create, start, stop, inspect, and remove Docker containers while keeping separation of concerns as strong as possible.

The pattern is useful when you want an approachable control plane instead of exposing raw Docker Compose or direct Docker CLI usage to operators or end users.

## Core idea

The design is a **brokered Docker control plane**:

1. A public-facing gateway handles TLS, identity, and request admission.
2. A control-plane service exposes the user-friendly API or UI.
3. Docker access is mediated through a dedicated socket proxy.
4. A dynamic router discovers and forwards traffic to ephemeral worker containers.
5. Worker containers perform the actual job and never receive Docker access.

This keeps ingress, authentication, orchestration, routing, and workload execution as separate responsibilities.

## Security model

### 1. Do not mount the raw Docker socket into the public control plane

Avoid giving the control-plane container direct access to:

```text
/var/run/docker.sock
```

Instead, place a dedicated proxy in front of the Docker API and let the control plane talk to that proxy over TCP on a private Docker network.

### 2. Put Docker API traffic on an internal-only network

Create a dedicated Docker network for Docker API access:

```yaml
socket_net:
driver: bridge
internal: true
```

The `internal: true` setting is important. It keeps this network out of normal external routing paths and reduces accidental exposure.

Only the small set of trusted components that must talk to Docker should join this network.

### 3. Keep trusted and untrusted services on different networks

A typical split is:

- `app_net`: gateway, auth proxy, control plane, router
- `socket_net`: Docker socket proxy, control plane, dynamic router
- optional workload networks: worker-specific traffic paths

Worker containers should join only the networks required for their runtime task. They should not be able to route back to the Docker API network.

### 4. Narrow Docker API capabilities

The socket proxy should expose only the Docker API areas your system actually needs.

Typical minimums for runtime orchestration are:

- containers
- images
- networks
- volumes
- events
- info/version/ping
- POST operations for create/start/stop/remove

Only enable `exec` if your design truly requires it. Avoid turning on broad capabilities “just in case.”

### 5. Constrain mounts and persistent state

The control plane should only be allowed to work with a bounded storage root, for example:

```text
/export/control-plane/data
```

If the control plane creates worker containers with mounts, those mounts should come from:

- a known allowlisted host path
- or named Docker volumes

Do not allow arbitrary bind mounts from user input.

### 6. Keep identity outside the Docker-control component

The public control surface should sit behind an auth layer such as:

- OAuth2/OIDC proxy
- identity-aware gateway
- reverse proxy with forward-auth

This ensures the component with Docker power is not also directly responsible for Internet-facing authentication logic.

## Separation of concerns

Use these roles as separate services.

| Role | Responsibility | Docker API access |
| — | — | — |
| Gateway | TLS termination, request forwarding, admission | No |
| Auth proxy | Identity and session handling | No |
| Control plane | Human-friendly API/UI for orchestration | Yes, through proxy only |
| Dynamic router | Discovers ephemeral workers and routes traffic | Yes, through proxy only |
| Worker containers | Perform the task | No |
| Socket proxy | Brokers access to Docker API | Mounts host socket read-only |

This split matters because each role has a different trust boundary.

## Request flow

1. A user reaches the public gateway.
2. The gateway checks identity through an auth proxy or forward-auth endpoint.
3. The gateway forwards approved traffic to the control plane or dynamic router.
4. The control plane translates the request into a safe worker spec.
5. The control plane creates or updates worker containers by talking to Docker through the socket proxy.
6. The dynamic router discovers active workers and forwards traffic to them.
7. Worker containers perform the business task without any Docker credentials or Docker network reachability.

## Why this is safer than direct socket mounting

Directly mounting `docker.sock` into a public-facing service greatly enlarges the blast radius of a compromise.

This pattern improves safety by adding:

- **network isolation** between normal app traffic and Docker API traffic
- **API narrowing** through an explicit socket proxy
- **role separation** between identity, orchestration, routing, and workload execution
- **storage narrowing** through allowlisted mounts and bounded persistent state
- **reduced lateral movement** because worker containers cannot control Docker

This is still a privileged architecture. Any service that can create containers is sensitive. The goal is not to make it harmless; the goal is to make the trust boundaries explicit and defensible.

## Best fit

This pattern fits best when the control plane manages **runtime container CRUD**:

- create
- inspect
- start
- stop
- restart
- remove
- attach networks
- attach approved volumes

It is strongest when workers are launched from a fixed catalog of trusted images.

## Important limitation

This pattern is not, by itself, the safest choice for arbitrary user-driven image builds or arbitrary user-supplied Compose graphs.

If users need to define:

- arbitrary Dockerfiles
- arbitrary bind mounts
- arbitrary Compose YAML
- arbitrary host networking

then you are moving from “runtime orchestration” into “general container platform” territory, which needs much stricter policy and isolation.

For most control-plane systems, prefer:

1. trusted prebuilt worker images
2. a strict worker spec schema
3. parameterized runtime configuration

If builds are unavoidable, isolate them into a separate build subsystem with tighter controls than the public control plane.

## Recommended service split for similar projects

### Gateway and auth

- terminates TLS
- performs authentication and session handling
- forwards only approved traffic inward
- has no Docker access

### Control plane

- exposes a clean UI or API
- validates requests
- maps approved input to a constrained worker spec
- talks to Docker only through the socket proxy

### Dynamic router

- discovers live worker containers
- routes traffic to them automatically
- talks to Docker only through the socket proxy

### Worker containers

- do the real business task
- receive only the networks, environment, and storage they need
- do not receive Docker access

### Optional build service

- use only if runtime image builds are required
- separate from the public control plane
- ideally available only to trusted internal automation

## Recommended control-plane contract

The control plane should not accept raw Docker objects from users.

Prefer a typed internal model such as:

- worker image ID
- resource profile
- environment preset
- ingress mode
- output target
- allowed volume references
- lifecycle policy

In other words, users request an approved **intent**, not raw Docker primitives.

## Good defaults

1. Use a fixed image catalog.
2. Use named volumes where possible.
3. Allowlist every host path.
4. Keep the Docker API on an internal network only.
5. Attach only the control plane and router to that network.
6. Audit every create/start/stop/remove action.
7. Rate-limit control-plane mutations.
8. Keep worker containers ephemeral.
9. Separate build responsibilities from runtime orchestration.

## Anti-patterns to avoid

- mounting `docker.sock` directly into the public app
- letting worker containers talk back to Docker
- accepting raw Compose YAML from users
- allowing arbitrary bind mounts
- combining auth, routing, and Docker control in one service
- treating the control plane as a generic shell over Docker
- enabling more Docker API categories than the system uses

## Minimal Compose skeleton

```yaml
services:
docker-socket-proxy:
image: lscr.io/linuxserver/socket-proxy:latest
restart: unless-stopped
volumes:
- /var/run/docker.sock:/var/run/docker.sock:ro
environment:
- CONTAINERS=1
- IMAGES=1
- NETWORKS=1
- VOLUMES=1
- EVENTS=1
- INFO=1
- VERSION=1
- PING=1
- POST=1
# - EXEC=1   # only if required
networks:
- socket_net

control-plane:
image: yourorg/control-plane:latest
restart: unless-stopped
environment:
- DOCKER_HOST=tcp://docker-socket-proxy:2375
- STORAGE_INTERNAL=/data
- STORAGE_EXTERNAL=/export/control-plane/data
- MOUNTS_WHITELIST=/export/control-plane/data
volumes:
- /export/control-plane/data:/data
networks:
- app_net
- socket_net

dynamic-router:
image: traefik:latest
restart: unless-stopped
command:
- —providers.docker.endpoint=tcp://docker-socket-proxy:2375
- —providers.docker.exposedbydefault=false
networks:
- app_net
- socket_net

auth-proxy:
image: quay.io/oauth2-proxy/oauth2-proxy
restart: unless-stopped
networks:
- app_net

networks:
app_net:
driver: bridge
socket_net:
driver: bridge
internal: true
```

## Guidance for agentic implementation

If this pattern is implemented through agentic coding, the safest target is:

1. define a fixed worker catalog
2. define a strict worker schema
3. validate all requested settings against policy
4. translate approved requests into Docker API calls
5. route traffic through a dedicated dynamic router
6. keep Docker access behind a socket proxy

An agent should not generate a design where end users submit raw Docker constructs directly unless the project explicitly intends to be a full container platform.

## Applying the pattern to other workloads

This architecture works well for systems that launch short-lived or per-session workers, including:

- browser automation
- media capture
- stream relays
- remote desktops
- sandboxed processing jobs
- preview environments

The main rule is the same in all cases: the workload container should do the work, but the control plane should be the only component allowed to orchestrate Docker, and even that access should be brokered and constrained.

## Implementing the pattern on Azure

This pattern can be hosted on Azure, but the implementation choice matters because many Azure managed container platforms do not expose a host Docker daemon for sibling-container CRUD.

There are two realistic Azure approaches.

### Option 1: Docker-compatible Azure infrastructure

If you want to preserve this pattern almost exactly, run the control plane on Azure infrastructure where you control the host runtime, such as:

- Azure Virtual Machines
- Virtual Machine Scale Sets
- a self-managed Docker cluster on Azure VMs

In that model, the architecture maps cleanly:

| Pattern role | Azure implementation |
| — | — |
| Gateway | Azure Front Door, Azure Application Gateway, or Nginx/Caddy on a VM |
| Auth layer | Microsoft Entra ID via OAuth2/OIDC proxy or an application gateway/auth layer |
| Control plane | Container or service running on Azure VM hosts |
| Socket proxy | Internal-only Docker socket proxy on the same VM host or worker node |
| Dynamic router | Traefik or another reverse proxy running in the same VNet |
| Worker containers | Ephemeral containers scheduled on the Docker hosts |
| Persistent state | Azure Files, managed disks, or Blob-backed application storage |

Recommended network layout:

1. Put the public gateway in a DMZ-style subnet or protected ingress tier.
2. Put the control plane, router, and Docker hosts in private subnets inside a VNet.
3. Keep the Docker API proxy reachable only on a private network path.
4. Use Network Security Groups so only the control plane and router can reach the proxy.
5. Keep worker containers off the Docker-control network.

Recommended supporting Azure services:

- **Microsoft Entra ID** for operator authentication
- **Azure Key Vault** for secrets, signing keys, and registry credentials
- **Azure Monitor / Log Analytics** for audit trails and lifecycle events
- **Azure Container Registry** for the approved worker image catalog
- **Azure DNS** and **Front Door/Application Gateway** for ingress

This is the closest Azure equivalent to the brokered Docker control-plane pattern described above.

### Option 2: Azure-native reinterpretation

If you want a more cloud-native Azure stack, keep the same separation of concerns but replace Docker daemon CRUD with control of an Azure-native compute substrate.

In other words:

- keep the **gateway**
- keep the **auth layer**
- keep the **control plane**
- keep the **dynamic routing**
- replace **Docker API calls** with calls to an Azure or orchestrator API

Typical targets are:

- AKS workloads managed through the Kubernetes API
- Azure Container Instances created through Azure APIs
- VM-based worker pools managed through Azure APIs or internal schedulers

In this version, the “socket proxy” concept becomes an **internal orchestration broker** rather than a literal Docker socket proxy.

The control plane would talk to:

- the Kubernetes API
- Azure Resource Manager APIs
- or a private internal worker-management service

This can be safer and more scalable in Azure, but it is no longer a strict Docker-socket pattern.

### Which Azure approach fits which need

Use the Docker-compatible VM-based approach when:

- you specifically need Docker container CRUD semantics
- you want compatibility with an existing local Docker-based design
- your workers are tightly tied to Docker images, volumes, and networks
- you want the smallest conceptual jump from local development

Use the Azure-native approach when:

- you want better horizontal scaling and cloud operations
- you do not need literal Docker socket access
- you are comfortable expressing workers as pods, jobs, or API-created instances
- you want to avoid managing Docker hosts directly

### Practical recommendation

If the goal is to reproduce this pattern faithfully, Azure VMs or VM Scale Sets are the most straightforward choice.

If the goal is to preserve the **architecture principle** rather than the exact Docker mechanism, Azure is often better served by:

1. a public ingress tier
2. Entra-backed authentication
3. a private control-plane service
4. an internal orchestration broker
5. ephemeral worker runtimes
6. bounded storage and secrets managed through Azure-native services

That keeps the important separation of concerns intact even if Docker itself is no longer the direct control surface.

### Example Docker to Native Azure Mapping

- Docker socket proxy -> Kubernetes API / AKS API
- container CRUD -> pod/deployment/service CRUD
- dynamic Traefik or other network discovery from Docker -> ingress/controller discovery from Kubernetes resources

### Azure-specific cautions

- Do not assume managed Azure container offerings will let one container manage sibling containers through a local Docker socket.
- Do not expose Docker or orchestration APIs directly to the Internet; always put them behind the control plane.
- Keep Azure role assignments narrow; the control plane should receive only the minimum permissions needed to create and manage worker runtimes.
- Keep secrets in Key Vault rather than embedding credentials in container definitions or startup scripts.
- Prefer an approved image catalog in Azure Container Registry over user-supplied arbitrary build inputs.
