# Pumice

[🇺🇸 English](README.md) | 🇰🇷 한국어

자체 호스팅 gRPC 서버([pumice-server](https://github.com/search5/pumice-server) — 필수, 직접
실행해야 함)와 vault를 동기화하는 옵시디언 커뮤니티 플러그인입니다. 목표는 vault에 파일이
얼마나 많든 즉시 동기화되는 것입니다.

## 개요

- **클라이언트**: TypeScript, 옵시디언 커뮤니티 플러그인(이 저장소)
- **서버**: Python(`asyncioreactor` + `grpc.aio` + `Twisted`), 자세한 내용은
  [pumice-server](https://github.com/search5/pumice-server) 참고
- **전송 방식**: gRPC-Web(HTTP/2 멀티플렉싱, 양방향 스트리밍) — 파일별로 RPC 하나씩이 아니라
  많은 파일을 하나의 커넥션 위에서 동시에 전송합니다. 서버가 TLS로 연결 가능할 때는 업로드가
  대신 단일 `fetch()` 요청으로 직접 스트리밍됩니다(배치 없음, 전체 페이로드를 메모리에
  버퍼링하지 않음). 그렇지 않으면 위의 gRPC-Web 경로로 폴백합니다.
- **인증**: 옵시디언 자체 보안 저장소(`App#secretStorage`, 데스크톱·모바일 공통, 플랫폼별
  코드 불필요)에 저장되는 고정 토큰

주요 기능:
- Vault 파일 동기화(델타 비교, 변경된 파일만 업로드/다운로드)
- 동기화 히스토리 탐색 및 파일 복구(`syncHistoryModal`, `fileRecoveryModal`)
- 보관 기간이 있는 자동 로컬 스냅샷(`localSnapshotStore`)
- 선택한 폴더의 선택적 게재(`publishModal`)
- 로컬라이제이션 지원(한국어/영어, `src/locales`)

## 요구 사항

- Node.js(npm 포함)
- `protoc`(3.21.12으로 확인됨)
- 옵시디언 1.12.7+ (`manifest.json`의 `minAppVersion`). 1.13.0+에서는 설정 탭이 선언형 설정
  API로 렌더링되고(그래서 옵시디언 자체 설정 검색에도 노출됩니다), 그 미만에서는
  `settingsTab.ts`의 `display()`가 같은 설정을 예전 방식(명령형)으로 그대로 렌더링합니다 —
  버전에 따라 옵시디언이 둘 중 하나만 호출하기 때문에 두 경로를 손으로 계속 맞춰줘야 합니다.

## 빌드

```bash
npm install

# 개발 모드(watch)
npm run dev

# 프로덕션 빌드
npm run build

# 타입 체크만
npm run lint
```

`main.js`는 `src/`로부터 esbuild가 생성합니다. 릴리스 시에는 `manifest.json`, `styles.css`와
함께 빌드되어 GitHub Release 아티팩트로 첨부됩니다.

### 릴리스하기

태그를 푸시하면 [`.github/workflows/release.yml`](.github/workflows/release.yml)이 실행되어
플러그인을 빌드하고 `main.js`, `manifest.json`, `styles.css`가 첨부된 GitHub Release를
만듭니다(이게 BRAT나 공식 Community Plugins 설치 프로그램이 기대하는 형태이기도 합니다).
태그는 `v` 접두사 없이 `manifest.json`의 `version`과 정확히 일치해야 합니다.

버전은 `npm version`으로 올립니다 — `manifest.json`과 `versions.json`을 동기화하고
(`version` 라이프사이클 스크립트로 연결된 `scripts/version-bump.mjs`를 통해) 일치하는 git
태그를 생성합니다(`.npmrc`가 npm의 기본 `v` 접두사를 끔):

```bash
npm version patch   # 또는 minor / major
git push --follow-tags
```

`versions.json`은 릴리스된 각 플러그인 버전을 당시 요구했던 `minAppVersion`에 매핑합니다 —
옵시디언 설치 프로그램이 이를 이용해 구버전 앱 사용자에게 호환되는 릴리스를 골라주는데, 이
플러그인이 Community Plugins 목록에 등록되면 중요해집니다.

`npm install`은 `postinstall` 스크립트를 통해 `protoc-gen-grpc-web` 바이너리를 받아오고,
`npm run dev`/`build`/`lint`는 각각 (`pre*` 스크립트를 통해) `sync.proto`로부터
`src/generated/`가 없으면 먼저 생성합니다 — 직접 설치해야 하는 건 `protoc` 뿐입니다. 자세한
내용은 [gRPC-Web 스텁 재생성하기](#grpc-web-스텁-재생성하기)를 참고하세요.

### 옵시디언에 로컬로 설치해서 테스트하기

1. `npm run build`를 실행해 `main.js`를 생성합니다.
2. vault에 `.obsidian/plugins/pumice/` 폴더를 만들고 `main.js`, `manifest.json`,
   `styles.css`를 복사해 넣습니다.
3. 옵시디언의 설정 → 커뮤니티 플러그인에서 Pumice를 활성화합니다.

## gRPC-Web 스텁 재생성하기

`src/generated/`(`sync_pb.js`, `sync_pb.d.ts`, `SyncServiceClientPb.ts`)는 `sync.proto`로부터
생성되고, 파생 산출물임에도 저장소에 커밋되어 있습니다(gitignore 대상 아님) — 이건 의도적인
결정입니다. 이 저장소를 lint/타입체크하는 외부 도구(예: Obsidian 자체 플러그인 심사)는
`npm install` 없이 그냥 clone해서 `src/`에 바로 돌리는데, `src/generated/`가 없으면 모든
`pb.*` 참조가 해석 불가/`any` 타입으로 무너져서 서로 무관해 보이는 `no-unsafe-*` 린트 에러가
수백 개 쏟아집니다. `scripts/ensure-generated.mjs`(`npm run dev`/`build`/`lint`의 `pre*`
스크립트로 연결됨)는 디렉터리가 없을 때만 재생성하므로, 일반적인 clone은 커밋된 걸 그대로
씁니다. `sync.proto`를 수정했다면 스텁을 명시적으로 재생성하고 결과를 커밋하세요:

```bash
npm run proto:gen
```

사전 준비물:
- 시스템에 설치된 `protoc`
- `protoc-gen-js`(`node_modules/.bin/protoc-gen-js`, `npm install`로 설치됨)
- `protoc-gen-grpc-web` 바이너리(`bin/protoc-gen-grpc-web`, v1.5.0 — 저장소에 넣기엔
  너무 커서 `npm install`이 `scripts/fetch-protoc-gen-grpc-web.mjs`라는 `postinstall`
  스크립트로 자동으로 받아옵니다). 사용 중인 플랫폼/아키텍처를 스크립트가 지원하지 않거나
  다운로드가 실패하면 [grpc-web 릴리스 페이지](https://github.com/grpc/grpc-web/releases/tag/1.5.0)
  링크를 출력하니 직접 받으면 됩니다.

`npm run proto:gen`은 다음 명령을 직접 실행합니다:

```bash
protoc \
  --plugin=protoc-gen-js=./node_modules/.bin/protoc-gen-js \
  --js_out=import_style=commonjs,binary:./src/generated \
  --plugin=protoc-gen-grpc-web=./bin/protoc-gen-grpc-web \
  --grpc-web_out=import_style=typescript,mode=grpcwebtext:./src/generated \
  --proto_path=. \
  sync.proto
```

## 설정

| 설정 | 기본값 | 설명 |
|---------|---------|-------------|
| serverHost | localhost | gRPC 서버 주소 |
| serverPort | 8080 | HTTP + gRPC-Web 포트 |
| useTls | false | TLS 사용(원격 서버라면 권장) |
| deviceName | Obsidian Client | 이 기기를 식별하는 이름 |
| userName | Obsidian User | 사용자 이름 |
| syncFiles | true | 파일 동기화 여부 |
| syncBookmarks | true | 북마크 포함 여부(`.obsidian/bookmarks.json`) |
| ignorePatterns | 아래 참고 | 동기화에서 제외할 경로 패턴 |
| autoSync | false | 자동 동기화 활성화 |
| syncIntervalSeconds | 60 | 자동 동기화 주기(초) |
| syncOnStartup | false | 시작 시 동기화 |
| conflictResolution | manual | 충돌 해결 전략(`manual` / `server-wins` / `client-wins`) |
| enableE2EE | false | 종단간 암호화 활성화 |
| publishIncludeFolders / publishExcludeFolders | - | 게재 시 포함/제외할 폴더 |
| localSnapshotIntervalMinutes | 5 | 로컬 스냅샷 간격(분) |
| localSnapshotKeepDays | 7 | 로컬 스냅샷 보관 기간(일) |

기본 제외 패턴(`ignorePatterns` / `publishExcludeFolders`):
```
.obsidian/workspace
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.obsidian/plugins/pumice
.trash
```

> **vault의 폴더 이름이 곧 서버상의 identity입니다.** 별도의 vault ID는 없습니다 — vault의
> 폴더 이름이 서버 쪽에서(동기화, 게재, 버전 히스토리) 모든 걸 키로 삼는 데 그대로 쓰입니다.
> 같은 vault를 동기화하는 모든 기기는 정확히 같은 이름의 폴더를 써야 합니다. 이름이 다르면
> 거부되는 게 아니라 그냥 무관한 vault로 취급되어 동기화됩니다. 설정 탭에 현재 vault의 이름이
> 표시되는 것도 이 때문입니다.

> **"현재 파일 게재"는 노트 프론트매터에 `publish: true`가 있어야 합니다.** 폴더 단위 포함
> (`publishIncludeFolders`)은 이게 필요 없지만, 단일 파일 강제 게재 액션은 프론트매터가 그렇게
> 되어 있어야만 업로드됩니다 — 그렇지 않으면 파일이 서버에는 게재되어 있으면서 다음 폴더
> 전체 게재 스캔(프론트매터 기반)에서는 조용히 범위 밖으로 빠질 수 있기 때문입니다.

## 프로젝트 구조

```
pumice/
├── src/
│   ├── main.ts                    # 플러그인 진입점
│   ├── settings.ts                # 설정 타입과 기본값
│   ├── settingsTab.ts             # 설정 패널 UI
│   ├── syncClient.ts              # gRPC 동기화 클라이언트
│   ├── syncHistoryModal.ts        # 동기화 히스토리 UI
│   ├── fileRecoveryModal.ts       # 파일 복구 UI
│   ├── publishModal.ts            # 선택적 게재 UI
│   ├── localSnapshotStore.ts      # 로컬 스냅샷 관리
│   ├── contentHashCache.ts        # 파일별 콘텐츠 해시 저장(mtime+size 키)
│   ├── concurrency.ts             # mapWithConcurrency / streamWithConcurrency 헬퍼
│   ├── diffView.ts                # 파일 diff 뷰
│   ├── swipeNavigation.ts         # 모바일 스와이프 내비게이션
│   ├── tokenStore.ts              # 인증 토큰 저장(App#secretStorage)
│   ├── errorMessage.ts            # 에러를 문자열로 변환하는 헬퍼
│   ├── i18n.ts, locales/          # 로컬라이제이션 문자열
│   └── generated/                 # protoc가 생성
├── bin/protoc-gen-grpc-web        # postinstall이 받아옴(저장소에 넣기엔 너무 큼)
├── scripts/
│   ├── fetch-protoc-gen-grpc-web.mjs  # npm install 시 bin/protoc-gen-grpc-web 다운로드
│   ├── gen-proto.mjs                  # protoc 실행, `npm run proto:gen`에서 사용
│   ├── ensure-generated.mjs           # src/generated/가 없으면 생성(pre-dev/build/lint)
│   └── version-bump.mjs               # manifest.json/versions.json 동기화, `npm version`에서 실행
├── main.js                        # esbuild가 생성
├── sync.proto                     # gRPC 스키마
├── manifest.json                  # 옵시디언 플러그인 매니페스트
├── versions.json                  # 플러그인 버전 → minAppVersion 매핑
└── esbuild.config.mjs             # 빌드 설정
```

## 기여하기

1. 저장소를 fork하고 브랜치를 만드세요.
2. 변경 후 `npm run lint`를 실행해 타입 에러가 없는지 확인하세요.
3. 커밋 메시지는 간결하게, 변경 이유 위주로 작성하세요.
4. Pull Request를 여세요. UI 변경이라면 스크린샷을 첨부해 주세요.

버그 신고나 기능 제안은 GitHub Issues를 이용해 주세요.

## 후원

이 프로젝트를 후원하고 싶으시면 search5@gmail.com으로 연락해주세요. 후원해주시면 개발에 더
많은 시간을 쏟는 데 실질적인 도움이 됩니다.

## 라이선스

[BSD 3-Clause License](LICENSE)
