import { AfterViewInit, Directive, ElementRef, inject, input } from '@angular/core';

/** Focuses the host element once it is rendered, when the bound value is true. */
@Directive({ selector: '[appAutofocus]' })
export class AutofocusDirective implements AfterViewInit {
  readonly appAutofocus = input<boolean | ''>(true);
  private el = inject(ElementRef<HTMLElement>);

  ngAfterViewInit() {
    if (this.appAutofocus() !== false) {
      setTimeout(() => this.el.nativeElement.focus());
    }
  }
}
