/**
 * @description 기본 컨트롤러 추상 클래스
 */
export abstract class AbstractController {
  public abstract readonly name: string;

  /**
   * 컨트롤러 초기화
   */
  public abstract destroy?(): void;
}
