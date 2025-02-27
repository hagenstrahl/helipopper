import {
  AfterViewInit,
  Directive,
  ElementRef,
  EventEmitter,
  Inject,
  Injector,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  PLATFORM_ID,
  ViewContainerRef
} from '@angular/core';
import { isPlatformServer } from '@angular/common';
import tippy, { Instance } from 'tippy.js';
import { fromEvent, merge, Subject } from 'rxjs';
import { filter, switchMap, takeUntil } from 'rxjs/operators';
import { Content, isComponent, isString, isTemplateRef, ViewOptions, ViewRef, ViewService } from '@ngneat/overview';

import {
  coerceCssPixelValue,
  dimensionsChanges,
  inView,
  normalizeClassName,
  onlyTippyProps,
  overflowChanges
} from './utils';
import { NgChanges, TIPPY_CONFIG, TIPPY_REF, TippyConfig, TippyInstance, TippyProps } from './tippy.types';

@Directive({
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: '[tippy]',
  exportAs: 'tippy',
  standalone: true
})
export class TippyDirective implements OnChanges, AfterViewInit, OnDestroy, OnInit {
  static ngAcceptInputType_useTextContent: boolean | '';

  @Input() appendTo: TippyProps['appendTo'];
  @Input() delay: TippyProps['delay'];
  @Input() duration: TippyProps['duration'];
  @Input() hideOnClick: TippyProps['hideOnClick'];
  @Input() interactive: TippyProps['interactive'];
  @Input() interactiveBorder: TippyProps['interactiveBorder'];
  @Input() maxWidth: TippyProps['maxWidth'];
  @Input() offset: TippyProps['offset'];
  @Input() placement: TippyProps['placement'];
  @Input() popperOptions: TippyProps['popperOptions'];
  @Input() showOnCreate: TippyProps['showOnCreate'];
  @Input() trigger: TippyProps['trigger'];
  @Input() triggerTarget: TippyProps['triggerTarget'];
  @Input() zIndex: TippyProps['zIndex'];
  @Input() animation: TippyProps['animation'];

  @Input() useTextContent: boolean;
  @Input() lazy: boolean;
  @Input() variation: string;
  @Input() isEnabled: boolean;
  @Input() className: string | string[];
  @Input() onlyTextOverflow = false;
  @Input() data: any;
  @Input() useHostWidth = false;
  @Input() hideOnEscape = false;
  @Input() detectChangesComponent = true;
  @Input() popperWidth: number | string;

  @Input('tippy') content: Content | undefined | null;
  @Input('tippyHost') customHost: HTMLElement;

  @Output() visible = new EventEmitter<boolean>();
  @Input() public isVisible = false;

  protected instance: TippyInstance;
  protected viewRef: ViewRef;
  protected destroyed = new Subject<void>();
  protected props: Partial<TippyConfig>;
  protected enabled = true;
  protected variationDefined = false;
  protected viewOptions$: ViewOptions;
  constructor(
    @Inject(PLATFORM_ID) protected platformId: string,
    @Inject(TIPPY_CONFIG) protected globalConfig: TippyConfig,
    protected injector: Injector,
    protected viewService: ViewService,
    protected vcr: ViewContainerRef,
    protected zone: NgZone,
    protected hostRef: ElementRef
  ) {}

  ngOnChanges(changes: NgChanges<TippyDirective>) {
    if (isPlatformServer(this.platformId)) return;

    let props: Partial<TippyConfig> = Object.keys(changes).reduce((acc, change) => {
      if (change === 'isVisible') return acc;

      acc[change] = changes[change].currentValue;

      return acc;
    }, {});

    let variation: string;

    if (isChanged<NgChanges<TippyDirective>>('variation', changes)) {
      variation = changes.variation.currentValue;
      this.variationDefined = true;
    } else if (!this.variationDefined) {
      variation = this.globalConfig.defaultVariation;
      this.variationDefined = true;
    }

    if (variation) {
      props = {
        ...this.globalConfig.variations[variation],
        ...props
      };
    }

    if (isChanged<NgChanges<TippyDirective>>('isEnabled', changes)) {
      this.enabled = changes.isEnabled.currentValue;
      this.setStatus();
    }

    if (isChanged<NgChanges<TippyDirective>>('isVisible', changes)) {
      this.isVisible ? this.show() : this.hide();
    }

    this.setProps({ ...this.props, ...props });
  }

  ngOnInit() {
    if (this.useHostWidth) {
      this.props.maxWidth = this.hostWidth;
    }
  }

  ngAfterViewInit() {
    if (isPlatformServer(this.platformId)) return;

    this.zone.runOutsideAngular(() => {
      if (this.lazy) {
        if (this.onlyTextOverflow) {
          inView(this.host)
            .pipe(
              switchMap(() => overflowChanges(this.host)),
              takeUntil(this.destroyed)
            )
            .subscribe(isElementOverflow => {
              this.checkOverflow(isElementOverflow);
            });
        } else {
          inView(this.host)
            .pipe(takeUntil(this.destroyed))
            .subscribe(() => {
              this.createInstance();
            });
        }
      } else if (this.onlyTextOverflow) {
        overflowChanges(this.host)
          .pipe(takeUntil(this.destroyed))
          .subscribe(isElementOverflow => {
            this.checkOverflow(isElementOverflow);
          });
      } else {
        this.createInstance();
      }
    });
  }

  ngOnDestroy() {
    this.destroyed.next();
    this.instance?.destroy();
    this.destroyView();
  }

  destroyView() {
    this.viewOptions$ = null;
    this.viewRef?.destroy();
    this.viewRef = null;
  }

  show() {
    this.instance?.show();
  }

  hide() {
    this.instance?.hide();
  }

  enable() {
    this.instance?.enable();
  }

  disable() {
    this.instance?.disable();
  }

  protected setProps(props: Partial<TippyConfig>) {
    this.props = props;
    this.instance?.setProps(onlyTippyProps(props));
  }

  protected setStatus() {
    this.enabled ? this.instance?.enable() : this.instance?.disable();
  }

  protected get host(): HTMLElement {
    return this.customHost || this.hostRef.nativeElement;
  }

  protected get hostWidth(): number {
    return this.host.getBoundingClientRect().width;
  }

  protected createInstance() {
    if (!this.content && !coerceBooleanInput(this.useTextContent)) {
      return;
    }

    this.zone.runOutsideAngular(() => {
      this.instance = tippy(this.host, {
        allowHTML: true,
        appendTo: document.body,
        ...onlyTippyProps(this.globalConfig),
        ...onlyTippyProps(this.props),
        onMount: instance => {
          this.zone.run(() => {
            this.isVisible = true;
            this.visible.next(true);
          });
          this.useHostWidth && this.listenToHostResize();
          this.globalConfig.onMount?.(instance);
        },
        onCreate: instance => {
          instance.popper.classList.add(`tippy-variation-${this.variation || this.globalConfig.defaultVariation}`);
          if (this.className) {
            for (const klass of normalizeClassName(this.className)) {
              instance.popper.classList.add(klass);
            }
          }
          this.globalConfig.onCreate?.(instance);
          if (this.isVisible === true) {
            instance.show();
          }
        },
        onShow: instance => {
          instance.reference.setAttribute('data-tippy-open', '');
          this.zone.run(() => {
            const content = this.resolveContent(instance);
            if (isString(content)) {
              instance.setProps({ allowHTML: false });

              if (!content?.trim()) {
                this.disable();
              } else {
                this.enable();
              }
            }

            instance.setContent(content);
            this.hideOnEscape && this.handleEscapeButton();
          });
          if (this.useHostWidth) {
            this.setInstanceWidth(instance, this.hostWidth);
          } else if (this.popperWidth) {
            this.setInstanceWidth(instance, this.popperWidth);
          }
          this.globalConfig.onShow?.(instance);
        },
        onHide(instance) {
          instance.reference.removeAttribute('data-tippy-open');
        },
        onHidden: instance => {
          this.destroyView();
          this.zone.run(() => {
            this.isVisible = false;
            this.visible.next(false);
          });
          this.globalConfig.onHidden?.(instance);
        }
      });

      this.setStatus();
      this.setProps(this.props);

      this.variation === 'contextMenu' && this.handleContextMenu();
    });
  }

  protected resolveContent(instance: TippyInstance) {
    if (!this.viewOptions$ && !isString(this.content)) {
      if (isComponent(this.content)) {
        this.instance.data = this.data;
        this.viewOptions$ = {
          injector: Injector.create({
            providers: [
              {
                provide: TIPPY_REF,
                useValue: this.instance
              }
            ],
            parent: this.injector
          })
        };
      } else if (isTemplateRef(this.content)) {
        this.viewOptions$ = {
          context: {
            $implicit: this.hide.bind(this),
            data: this.data
          }
        };
      }
    }

    this.viewRef = this.viewService.createView(this.content, {
      vcr: this.vcr,
      ...this.viewOptions$
    });

    // We need to call detectChanges for onPush components to update the content
    if (this.detectChangesComponent && isComponent(this.content)) {
      this.viewRef.detectChanges();
    }

    let content = this.viewRef.getElement();

    if (coerceBooleanInput(this.useTextContent)) {
      content = instance.reference.textContent;
    }

    if (isString(content) && this.globalConfig.beforeRender) {
      content = this.globalConfig.beforeRender(content);
    }

    return content;
  }

  protected handleContextMenu() {
    fromEvent(this.host, 'contextmenu')
      .pipe(takeUntil(this.destroyed))
      .subscribe((event: MouseEvent) => {
        event.preventDefault();

        this.instance.setProps({
          getReferenceClientRect: () =>
            ({
              width: 0,
              height: 0,
              top: event.clientY,
              bottom: event.clientY,
              left: event.clientX,
              right: event.clientX
            } as DOMRectReadOnly)
        });

        this.instance.show();
      });
  }

  protected handleEscapeButton() {
    this.pressButton$(document.body, 'Escape')
      .pipe(takeUntil(merge(this.destroyed, this.visible.pipe(filter(v => !v)))))
      .subscribe(() => this.hide());
  }

  protected pressButton$(element: HTMLElement, codeButton: string) {
    return fromEvent(element, 'keydown').pipe(filter(({ code }: KeyboardEvent) => codeButton === code));
  }

  protected checkOverflow(isElementOverflow: boolean) {
    if (isElementOverflow) {
      if (!this.instance) {
        this.createInstance();
      } else {
        this.instance.enable();
      }
    } else {
      this.instance?.disable();
    }
  }

  protected listenToHostResize() {
    dimensionsChanges(this.host)
      .pipe(takeUntil(merge(this.destroyed, this.visible)))
      .subscribe(() => {
        this.setInstanceWidth(this.instance, this.hostWidth);
      });
  }

  protected setInstanceWidth(instance: Instance, width: string | number) {
    const inPixels = coerceCssPixelValue(width);
    instance.popper.style.width = inPixels;
    instance.popper.style.maxWidth = inPixels;
    (instance.popper.firstElementChild as HTMLElement).style.maxWidth = inPixels;
  }
}

function isChanged<T>(key: keyof T, changes: T) {
  return key in changes;
}

export function coerceBooleanInput(value: any): boolean {
  return value != null && `${value}` !== 'false';
}
