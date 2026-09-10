/**
 * @description 기본 컨트롤러 추상 클래스
 */
export abstract class AbstractController {
  public abstract readonly name: string;

  /**
   * 인스턴스 폐기. 자원을 놓고 스트림을 닫는다. 폐기한 컨트롤러는 다시 쓰지 않는다.
   */
  public abstract destroy(): void;
}
