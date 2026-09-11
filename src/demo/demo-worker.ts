/**
 * 데모의 워커 진입점 — 소비자가 만들어야 하는 파일의 예시다.
 *
 * 허브를 띄우고, 이 앱이 쓰는 프로토콜만 등록한다. 등록하지 않은 프로토콜을 요청하면
 * 무엇을 import 해야 하는지 알려주며 실패한다.
 */
import "../lib/worker/socket-worker";
import "../lib/worker/stomp";
import "../lib/worker/mqtt";
