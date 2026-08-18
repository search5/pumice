# Pumice

[🇺🇸 English](README.md) | 🇰🇷 한국어

자체 호스팅 서버([pumice-server](https://github.com/search5/pumice-server) — 필수, 직접
실행해야 함)와 vault를 동기화하는 옵시디언 커뮤니티 플러그인입니다. 목표는 vault에 파일이
얼마나 많든 즉시 동기화되는 것입니다.

## 개요

- **클라이언트**: TypeScript, 옵시디언 커뮤니티 플러그인(이 저장소)
- **서버**: Python(`asyncioreactor` + `Twisted`), 자세한 내용은
  [pumice-server](https://github.com/search5/pumice-server) 참고
- **전송 방식**: 로그인하면 자동으로 열리고 옵시디언이 실행되는 동안 계속 유지되는 단일 상시
  연결 WebSocket — 옵시디언 자체 내장 Sync 플러그인 방식을 참고해 설계되어, 한 기기에서의
  수정이 정해진 동기화 주기를 기다리지 않고 다른 기기에 바로 반영됩니다. (이전 버전은
  gRPC-Web 방식으로 RPC 하나당 HTTP/2 요청 하나였고 실시간 push도 없었는데, 이번 버전에서
  완전히 대체했습니다.)
- **인증**: 옵시디언 자체 보안 저장소(`App#secretStorage`, 데스크톱·모바일 공통, 플랫폼별
  코드 불필요)에 저장되는 고정 토큰

주요 기능:
- Vault 파일 동기화(델타 비교, 변경된 파일만 업로드/다운로드)
- 동기화 히스토리 탐색 및 파일 복구(`syncHistoryModal`, `fileRecoveryModal`)
- 보관 기간이 있는 자동 로컬 스냅샷(`localSnapshotStore`)
- 선택한 폴더의 선택적 게재(`publishModal`) — 커스텀 도메인, 내비게이션, 외형 옵션 포함
- Site collaboration — 다른 계정이 협업자로 승인해준 사이트에 게재(`공유 사이트 게재…` 명령,
  `sharedSitePickerModal`)
- Vault 공유 — 내 vault를 다른 계정의 vault에 맞춰 동기화하거나(`sharedVaultOwner` 설정), 누가
  내 vault를 동기화할 수 있는지 관리(`vaultShareModal`)
- 커뮤니티 플러그인 동기화 — 설치된 플러그인의 코드/`data.json`을 선택적으로 동기화
  (`syncPlugins` / `syncPluginData`, 둘 다 기본 꺼짐)
- 건너뛴/대기 중인 동기화를 확인하기 위한 동기화 진단 로그(`동기화 진단 로그 열기` 명령,
  `syncDiagnosticsModal`)
- 로컬라이제이션 지원(한국어/영어, `src/locales`)

## 요구 사항

- Node.js(npm 포함)
- 옵시디언 1.13.4+ (`manifest.json`의 `minAppVersion`). 설정 탭은 선언형 설정 API
  (`getSettingDefinitions()`)만으로 렌더링되므로(그래서 옵시디언 자체 설정 검색에도
  노출됩니다), 손으로 맞춰줘야 하는 예전 방식(명령형)의 폴백 UI는 더 이상 없습니다.

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

### 옵시디언에 로컬로 설치해서 테스트하기

1. `npm run build`를 실행해 `main.js`를 생성합니다.
2. vault에 `.obsidian/plugins/pumice/` 폴더를 만들고 `main.js`, `manifest.json`,
   `styles.css`를 복사해 넣습니다.
3. 옵시디언의 설정 → 커뮤니티 플러그인에서 Pumice를 활성화합니다.

## 동기화 동작 방식

로그인하면(설정 → Pumice → "로그인" — 시스템 브라우저에서 서버의 로그인 페이지가 열리고,
성공하면 토큰이 옵시디언으로 돌아옵니다) 플러그인은 옵시디언이 실행되는 동안 서버와의
WebSocket 연결을 하나 계속 열어둡니다 — 옵시디언 공식 Sync와 동일하게, 별도의 "실시간
업데이트 켜기" 토글이나 동기화 주기 설정은 없습니다. 이 연결이 하는 일:

- 로컬에서 편집한 내용을 서버로 올립니다(짧게 디바운스되어, 키 입력이 연달아 일어나도
  업로드는 한 번으로 묶입니다).
- 다른 기기의 변경 사항을 받아서 즉시 반영합니다.
- push 활동과 무관하게 30초마다 전체 안전망 동기화를 한 번씩 돌려서, 혹시라도 push 알림을
  놓치더라도 영구히 어긋난 상태로 남지 않게 합니다.

상태바 아이콘은 옵시디언 코어 Sync 아이콘과 동일한 방식으로 이 연결 상태를 보여줍니다 —
마우스를 올리면 "동기화 중…", "동기화 완료", "동기화 오류" 같은 짧은 상태가 뜹니다. 수동으로
동기화를 실행하면(리본 아이콘 또는 명령 팔레트) 여전히 토스트 알림이 뜨지만, 위에서 설명한
자동 백그라운드 동작은 실제로 실패하지 않는 한 조용히 진행됩니다.

연결이 끊기면(네트워크 순단, 서버 재시작, 노트북 절전 등) 자체적으로 백오프하며 재연결하고,
끊겨 있던 동안 바뀐 부분만 따라잡습니다 — 재연결할 때마다 vault 전체를 다시 스캔하지 않습니다.

## 설정

| 설정 | 기본값 | 설명 |
|---------|---------|-------------|
| serverHost | localhost | Pumice 서버 주소 |
| serverPort | 8080 | HTTP + WebSocket 포트 |
| useTls | false | TLS 사용(원격 서버라면 권장) |
| deviceName | OS 호스트명(데스크톱) 또는 "Obsidian Client" | 이 기기를 식별하는 이름 |
| userName | Obsidian User | 사용자 이름 |
| sharedVaultOwner | (비어 있음) | 설정하면 내 vault 대신 그 계정의 vault와 동기화 — 해당 계정이 공유를 승인해야 하고, 이 vault의 폴더 이름이 그 계정의 vault ID와 정확히 일치해야 함 |
| syncFiles | true | 파일 동기화 여부 |
| syncBookmarks | true | 북마크 포함 여부(`.obsidian/bookmarks.json`) |
| syncPlugins | false | 설치된 커뮤니티 플러그인의 코드/매니페스트 동기화(기본 꺼짐 — 노트 내용보다 신뢰 범위가 큰 실행 코드라서) |
| syncPluginData | false | 각 플러그인 자체의 `data.json`까지 동기화(기본 꺼짐 — 흔히 API 토큰 등 비밀값이 평문으로 들어있음) |
| ignorePatterns | 아래 참고 | 동기화에서 제외할 경로 패턴 |
| conflictResolution | server-wins | 비텍스트 파일, 또는 병합 기준이 없는 텍스트 파일에서 어느 쪽이 우선할지(`server-wins` / `client-wins`) — 텍스트 파일(노트, `.json`/`.css`/`.js`/`.base`/`.canvas`)은 이 설정과 무관하게 항상 먼저 3-way 병합을 시도합니다 |
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
│   ├── main.ts                    # 플러그인 진입점, 상시 연결 생명주기 관리
│   ├── settings.ts                # 설정 타입과 기본값
│   ├── settingsTab.ts             # 설정 패널 UI
│   ├── settingsTabConnection.ts   # 어떤 설정 변경이 WS 연결을 끊고 다시 만들어야 하는지 판단
│   ├── settingsTabKeyboard.ts     # 코어의 Tab 내비게이션 keydown 핸들러 우회
│   ├── syncClient.ts              # 동기화 오케스트레이션(스캔/E2EE/충돌 해결/해싱)
│   ├── syncTransport.ts           # syncClient.ts가 사용하는 전송 방식 무관 인터페이스
│   ├── wsTransport.ts             # WebSocket 프로토콜 계층(프레이밍/하트비트/재연결)
│   ├── wsSyncTransportAdapter.ts  # wsTransport.ts를 syncTransport.ts 인터페이스에 맞춤
│   ├── liveUpdates.ts, liveStatus.ts  # 재연결 백오프, 상태바 아이콘/상태 모델
│   ├── batching.ts                # 경로 목록을 바이트 크기+파일 수 기준으로 배치 분할
│   ├── concurrency.ts             # mapWithConcurrency / streamWithConcurrency 헬퍼
│   ├── contentHashCache.ts        # 파일별 콘텐츠 해시 저장(mtime+size 키)
│   ├── lastSyncedHashStore.ts     # 3-way 병합이 기준으로 삼는 경로별 "base" 해시
│   ├── textFileTypes.ts           # 텍스트 파일 판별 공용 로직(병합/diff 대상 여부)
│   ├── syncHistoryModal.ts        # 동기화 히스토리 UI
│   ├── fileRecoveryModal.ts       # 파일 복구 UI
│   ├── localSnapshotStore.ts      # 로컬 스냅샷 관리
│   ├── diffView.ts                # 파일 diff 뷰
│   ├── syncDiagnosticsLog.ts, syncDiagnosticsModal.ts  # 인메모리 동기화 로그 + 조회 UI
│   ├── publishModal.ts            # 선택적 게재 UI(폴더, 사이트 옵션, 커스텀 도메인)
│   ├── publishEligibility.ts      # "이 파일을 게재해야 하는가" 순수 판단 로직
│   ├── navigationOrdering.ts      # 게재된 사이트의 Customize sidebar 드래그 정렬 로직
│   ├── siteCollaboration.ts, sharedSitePickerModal.ts  # 다른 계정 소유 사이트에 게재
│   ├── vaultShareModal.ts         # vault 동기화 공유용 소유자 전용 "공유 관리" UI
│   ├── pluginSync.ts              # .obsidian/plugins/** 동기화 로직(선택적)
│   ├── pluginReload.ts            # 동기화로 새 코드가 내려온 후 커뮤니티 플러그인 핫리로드
│   ├── swipeNavigation.ts         # 모바일 스와이프 내비게이션
│   ├── tokenStore.ts              # 인증 토큰 저장(App#secretStorage)
│   ├── deviceName.ts              # 기본 기기 이름 결정(OS 호스트명 폴백)
│   ├── errorMessage.ts            # 에러를 문자열로 변환하는 헬퍼
│   ├── momentUtil.ts              # 옵시디언의 로케일 인식 moment 인스턴스를 감싼 타입 헬퍼
│   └── i18n.ts, locales/          # 로컬라이제이션 문자열
├── scripts/
│   └── version-bump.mjs           # manifest.json/versions.json 동기화, `npm version`에서 실행
├── main.js                        # esbuild가 생성
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
